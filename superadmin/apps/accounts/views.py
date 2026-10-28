from datetime import timedelta
from urllib.parse import urlencode

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model, update_session_auth_hash
from django.contrib.auth import login as auth_login
from django.contrib.auth import logout as auth_logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import PasswordChangeForm, SetPasswordForm
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Prefetch
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.http import url_has_allowed_host_and_scheme, urlsafe_base64_decode
from django.views.decorators.http import require_http_methods, require_POST
from django_otp import login as otp_login
from django_otp.plugins.otp_totp.models import TOTPDevice

from apps.audit.services import record
from apps.autofix import selectors as autofix_selectors
from apps.autofix.db import AutofixUnavailable
from apps.core.forms import StyledFormMixin
from apps.core.htmx import changed_response, close_modal_response

from . import otp, services
from .forms import (
    ApiTokenForm,
    ConfirmPasswordForm,
    LoginForm,
    OTPTokenForm,
    ProfileForm,
    UserCreateForm,
    UserEditForm,
)
from .models import ApiToken
from .roles import ROLES, SUPERADMIN, is_superadmin, primary_role, role_required
from .tokens import set_password_token


class StyledPasswordChangeForm(StyledFormMixin, PasswordChangeForm):
    pass


class StyledSetPasswordForm(StyledFormMixin, SetPasswordForm):
    pass


LAST_EMAIL_COOKIE = "afsa_last_email"


def _next_url(request, default=None) -> str:
    candidate = request.POST.get("next") or request.GET.get("next")
    if candidate and url_has_allowed_host_and_scheme(
        candidate, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        return candidate
    return default or reverse(settings.LOGIN_REDIRECT_URL)


def _second_factor_redirect(request, user):
    name = "accounts:otp_verify" if otp.confirmed_devices(user).exists() else "accounts:otp_setup"
    return HttpResponseRedirect(f"{reverse(name)}?{urlencode({'next': _next_url(request)})}")


@require_http_methods(["GET", "HEAD", "POST"])
def login_view(request):
    user = request.user
    if user.is_authenticated:
        if otp.otp_required(user) and not user.is_verified():
            return _second_factor_redirect(request, user)
        return HttpResponseRedirect(_next_url(request))
    remembered = request.COOKIES.get(LAST_EMAIL_COOKIE, "")
    initial = {"email": settings.DEFAULT_SIGNIN_EMAIL or remembered}
    form = LoginForm(request, data=request.POST or None, initial=initial)
    if request.method == "POST" and form.is_valid():
        auth_login(request, form.user)
        if otp.otp_required(form.user):
            response = _second_factor_redirect(request, form.user)
        else:
            response = HttpResponseRedirect(_next_url(request))
        # Remember the last email on this browser (first-party, HttpOnly) to save retyping it.
        response.set_cookie(
            LAST_EMAIL_COOKIE,
            form.user.email,
            max_age=90 * 24 * 60 * 60,
            path=settings.COOKIE_PATH,
            secure=request.is_secure(),
            httponly=True,
            samesite="Strict",
        )
        return response
    context = {"form": form, "next": _next_url(request, default="")}
    return render(request, "accounts/login.html", context)


@login_required
@require_http_methods(["GET", "POST"])
def otp_verify(request):
    user = request.user
    if user.is_verified() or not otp.confirmed_devices(user).exists():
        return HttpResponseRedirect(_next_url(request))
    form = OTPTokenForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        device = otp.verify(user, form.cleaned_data["token"])
        if device is not None:
            otp_login(request, device)
            return HttpResponseRedirect(_next_url(request))
        form.add_error("token", "That code is not valid. Check your device's clock and try again.")
    return render(request, "accounts/otp_verify.html", {"form": form, "next": _next_url(request, default="")})


@login_required
@require_http_methods(["GET", "POST"])
def otp_setup(request):
    user = request.user
    if otp.confirmed_devices(user).exists():
        return HttpResponseRedirect(_next_url(request))
    device = otp.pending_device(user)
    form = OTPTokenForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        token = "".join(ch for ch in form.cleaned_data["token"] if ch.isdigit())
        if device.verify_token(token):
            device.confirmed = True
            device.save(update_fields=["confirmed"])
            otp_login(request, device)
            record("auth.mfa_enrolled", request=request, entity=user, summary="Authenticator app enrolled")
            messages.success(request, "Two-factor authentication is on.")
            return HttpResponseRedirect(_next_url(request))
        form.add_error("token", "That code did not match. Scan the QR code again and enter the current code.")
    context = {
        "form": form,
        "qr_svg": otp.qr_svg(device),
        "secret": otp.base32_secret(device),
        "required": otp.otp_required(user),
        "next": _next_url(request, default=""),
    }
    return render(request, "accounts/otp_setup.html", context)


@require_POST
def logout_view(request):
    auth_logout(request)
    messages.info(request, "You have signed out.")
    return redirect("accounts:login")


def _user_from_uid(uidb64):
    try:
        pk = int(force_str(urlsafe_base64_decode(uidb64)))
    except (TypeError, ValueError, OverflowError):
        return None
    return get_user_model().objects.filter(pk=pk, is_active=True).first()


def _no_store(response):
    response["Cache-Control"] = "no-store"
    return response


@require_http_methods(["GET", "POST"])
def set_password(request, uidb64, token):
    """Single-use, 30-minute link from `manage.py issue_setup_link` (printed to a terminal only)."""
    user = _user_from_uid(uidb64)
    if user is None or not set_password_token.check_token(user, token):
        context = {"invalid": True}
        return _no_store(render(request, "accounts/set_password.html", context, status=400))
    form = StyledSetPasswordForm(user, request.POST or None)
    if request.method == "POST" and form.is_valid():
        form.save()  # Changes the password hash, which invalidates this link.
        record(
            "auth.password_set", request=request, actor=user, entity=user, summary="Password set from link"
        )
        if request.user.is_authenticated:
            auth_logout(request)
        messages.success(request, "Your password is set. Sign in to continue.")
        return redirect("accounts:login")
    return _no_store(render(request, "accounts/set_password.html", {"form": form, "email": user.email}))


@login_required
@require_http_methods(["GET", "POST"])
def account(request):
    user = request.user
    action = request.POST.get("action") if request.method == "POST" else None
    profile_form = ProfileForm(request.POST if action == "profile" else None, instance=user)
    password_form = StyledPasswordChangeForm(user, request.POST if action == "password" else None)
    reset_form = ConfirmPasswordForm(user, request.POST if action == "reset_2fa" else None)
    if action == "profile" and profile_form.is_valid():
        profile_form.save()
        messages.success(request, "Profile updated.")
        return redirect("accounts:account")
    if action == "password" and password_form.is_valid():
        password_form.save()
        update_session_auth_hash(request, password_form.user)
        record("auth.password_changed", request=request, entity=user, summary="Password changed")
        messages.success(request, "Password changed.")
        return redirect("accounts:account")
    if action == "reset_2fa" and reset_form.is_valid():
        TOTPDevice.objects.filter(user=user).delete()
        record("auth.mfa_reset", request=request, entity=user, summary="Authenticator removed")
        auth_logout(request)
        messages.info(request, "Your authenticator was removed. Sign in again to enrol a new one.")
        return redirect("accounts:login")
    context = {
        "profile_form": profile_form,
        "password_form": password_form,
        "reset_form": reset_form,
        "has_device": otp.confirmed_devices(user).exists(),
        "otp_required": otp.otp_required(user),
        "role": primary_role(user),
    }
    return render(request, "accounts/account.html", context)


# --- Settings: users & roles -------------------------------------------------------------------


def settings_index(request):
    if not request.user.is_authenticated:
        return redirect(f"{reverse('accounts:login')}?next=/settings/")
    target = "accounts:settings_users" if is_superadmin(request.user) else "accounts:settings_tokens"
    return redirect(target)


@role_required(SUPERADMIN)
def settings_users(request):
    User = get_user_model()
    users = User.objects.prefetch_related(Prefetch("groups", queryset=Group.objects.filter(name__in=ROLES)))
    rows = [{"user": user, "role": primary_role(user)} for user in users]
    return render(request, "settings/users.html", {"rows": rows, "tab": "users"})


@role_required(SUPERADMIN)
@require_http_methods(["GET", "POST"])
def user_create(request):
    form = UserCreateForm(request.POST or None, user=request.user)
    if request.method == "POST" and form.is_valid():
        data = form.cleaned_data
        try:
            services.create_user(
                email=data["email"],
                full_name=data["full_name"],
                role=data["role"],
                password=data["password"],
                actor=request.user,
                request=request,
            )
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            return close_modal_response(
                request,
                reverse("accounts:settings_users"),
                f"User {data['email']} created with the {data['role']} role.",
            )
    return render(
        request,
        "partials/form_modal.html",
        {
            "form": form,
            "title": "Add user",
            "action": reverse("accounts:user_create"),
            "submit": "Create user",
        },
    )


def _admin_choices() -> list[tuple[str, str]]:
    """Autofix platform admins for the link field; empty when Autofix data is not connected."""
    try:
        return autofix_selectors.platform_admin_choices()
    except AutofixUnavailable:
        return []


@role_required(SUPERADMIN)
@require_http_methods(["GET", "POST"])
def user_edit(request, pk):
    target = get_object_or_404(get_user_model(), pk=pk)
    initial = {
        "full_name": target.full_name,
        "role": primary_role(target) or "",
        "autofix_admin": str(target.autofix_admin_id or ""),
        "is_active": target.is_active,
    }
    choices = _admin_choices()
    if target.autofix_admin_id and str(target.autofix_admin_id) not in {key for key, _ in choices}:
        choices.append((str(target.autofix_admin_id), f"{target.autofix_admin_id} (not found in Autofix)"))
    form = UserEditForm(request.POST or None, initial=initial, admin_choices=choices, user=request.user)
    if request.method == "POST" and form.is_valid():
        data = form.cleaned_data
        try:
            with transaction.atomic():
                services.set_role(target, data["role"] or None, request.user, request=request)
                services.set_active(target, data["is_active"], request.user, request=request)
                services.link_autofix_admin(
                    target, data["autofix_admin"] or None, request.user, request=request
                )
                if target.full_name != data["full_name"]:
                    target.full_name = data["full_name"]
                    target.save(update_fields=["full_name"])
        except ValidationError as exc:
            form.add_error(None, exc)
        else:
            return close_modal_response(
                request, reverse("accounts:settings_users"), f"{target.email} updated."
            )
    return render(
        request,
        "partials/form_modal.html",
        {
            "form": form,
            "title": f"Edit {target.email}",
            "action": reverse("accounts:user_edit", args=[target.pk]),
            "submit": "Save",
        },
    )


# --- Settings: API tokens ----------------------------------------------------------------------


@role_required()
@require_http_methods(["GET", "POST"])
def settings_tokens(request):
    user = request.user
    form = ApiTokenForm(request.POST or None, user=user)
    new_token = None
    if request.method == "POST" and form.is_valid():
        days = form.cleaned_data["expires_in_days"]
        expires_at = timezone.now() + timedelta(days=days) if days else None
        token, new_token = ApiToken.issue(user, form.cleaned_data["name"], expires_at=expires_at)
        form = ApiTokenForm(user=user)
    tokens = ApiToken.objects.select_related("user")
    if not is_superadmin(user):
        tokens = tokens.filter(user=user)
    context = {"form": form, "tokens": tokens, "new_token": new_token, "tab": "tokens"}
    response = render(request, "settings/tokens.html", context)
    if new_token:
        response["Cache-Control"] = "no-store"
    return response


@role_required()
@require_POST
def token_revoke(request, pk):
    token = get_object_or_404(ApiToken, pk=pk)
    if token.user_id != request.user.pk and not is_superadmin(request.user):
        raise PermissionDenied
    if token.revoked_at is None:
        token.revoked_at = timezone.now()
        token.save(update_fields=["revoked_at"])
    return changed_response(request, reverse("accounts:settings_tokens"), f"Token “{token.name}” revoked.")
