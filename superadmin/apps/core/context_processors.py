from django.conf import settings

from apps.accounts.otp import confirmed_devices, otp_required
from apps.accounts.roles import (
    can_change_autofix,
    can_operate,
    can_support,
    has_any_role,
    is_superadmin,
    primary_role,
    role_label,
)
from apps.audit.services import previous_sign_in

from . import navigation

THEME_COOKIE = "theme"
THEMES = ("light", "dark", "system")
SIDEBAR_COOKIE = "sidebar_state"
ENVIRONMENT_LABELS = {
    "production": "Production",
    "staging": "Staging",
    "development": "Local",
    "test": "Test",
}


def _initials(user) -> str:
    name = (user.full_name or user.email.split("@")[0]).replace(".", " ").split()
    return "".join(part[0] for part in name[:2]).upper() or "?"


def app_context(request):
    """Values every template needs: CSP nonce for django-htmx, role flags and environment."""
    user = getattr(request, "user", None)
    htmx = getattr(request, "htmx", None)
    authenticated = bool(user and user.is_authenticated)
    # Until the second factor is done, render no app chrome (its HTMX polls would bounce).
    verified = getattr(user, "is_verified", lambda: True)()
    pending_otp = authenticated and not verified and otp_required(user)
    show_chrome = authenticated and not pending_otp
    theme = request.COOKIES.get(THEME_COOKIE, "system")
    path = request.path
    return {
        "show_chrome": show_chrome,
        "theme": theme if theme in THEMES else "system",
        "sidebar_collapsed": request.COOKIES.get(SIDEBAR_COOKIE) == "collapsed",
        "nav_groups": navigation.nav_groups(path, user) if show_chrome else [],
        "nav_active": navigation.active_item(path) if show_chrome else None,
        "nav_crumb": navigation.crumb_label(navigation.active_item(path)) if show_chrome else "",
        "csp_nonce": getattr(request, "csp_nonce", ""),
        "app_environment": settings.APP_ENVIRONMENT,
        "is_superadmin": authenticated and is_superadmin(user),
        "can_support": authenticated and can_support(user),
        "can_operate": authenticated and can_operate(user),
        "can_change_autofix": authenticated and can_change_autofix(user),
        "has_role": authenticated and has_any_role(user),
        "user_role": primary_role(user) if authenticated else None,
        "modal_base": "partials/modal_shell.html" if htmx else "partials/page_shell.html",
        "environment_label": ENVIRONMENT_LABELS.get(
            settings.APP_ENVIRONMENT, settings.APP_ENVIRONMENT.title()
        ),
        # Callables: evaluated only when the full layout renders, never for HTMX partials.
        "user_initials": (lambda: _initials(user)) if authenticated else "",
        "role_label": (lambda: role_label(user)) if authenticated else "",
        "mfa_enabled": (lambda: confirmed_devices(user).exists()) if authenticated else False,
        "previous_sign_in": (lambda: previous_sign_in(user)) if authenticated else None,
    }
