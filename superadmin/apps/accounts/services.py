"""User and role administration rules."""

from django.contrib.auth import get_user_model, password_validation
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.urls import reverse

from apps.audit.services import record
from apps.notifications.models import Notification
from apps.notifications.services import notify

from .roles import ROLES, SUPERADMIN, clear_role_cache, is_superadmin


def primary_owner():
    return get_user_model().objects.filter(is_primary_owner=True).first()


def _check_superadmin_change(user, actor) -> None:
    """Once a primary owner exists, only they may grant or revoke SuperAdmin."""
    owner = primary_owner()
    if actor is not None and owner is not None and actor.pk != owner.pk:
        raise ValidationError("Only the primary owner can grant or revoke the SuperAdmin role.")


def ensure_roles() -> None:
    for name in ROLES:
        Group.objects.get_or_create(name=name)


@transaction.atomic
def set_role(user, role: str | None, actor, request=None) -> bool:
    """Give ``user`` exactly one role (or none). Notifies the user and audits the change."""
    if actor is not None and not is_superadmin(actor):
        raise PermissionDenied
    if role is not None and role not in ROLES:
        raise ValidationError(f"Unknown role {role!r}.")
    if actor is not None and actor.pk == user.pk and role != SUPERADMIN and is_superadmin(actor):
        raise ValidationError("You cannot remove your own SuperAdmin role.")
    if user.is_primary_owner and role != SUPERADMIN:
        raise ValidationError("The primary owner always keeps the SuperAdmin role.")
    if user.is_superuser and role != SUPERADMIN:
        # A Django superuser is always SuperAdmin; showing another role would be misleading.
        raise ValidationError("This account is a Django superuser. Remove that flag in Django admin first.")
    ensure_roles()
    previous = set(user.groups.filter(name__in=ROLES).values_list("name", flat=True))
    target = {role} if role else set()
    if previous == target:
        return False
    if SUPERADMIN in previous ^ target:
        _check_superadmin_change(user, actor)
    user.groups.remove(*Group.objects.filter(name__in=previous - target))
    if role:
        user.groups.add(Group.objects.get(name=role))
    clear_role_cache(user)
    record(
        "users.role_changed",
        request=request,
        actor=actor,
        entity=user,
        summary=f"{user.email}: {', '.join(sorted(previous)) or 'no role'} → {role or 'no role'}",
        previous=sorted(previous),
        role=role,
    )
    if role:
        notify(
            [user],
            Notification.Kind.ROLE_ASSIGNED,
            title=f"You now have the {role} role",
            body=f"Assigned by {actor}." if actor else "Assigned during setup.",
            url=reverse("core:overview"),
        )
    return True


@transaction.atomic
def create_user(*, email: str, full_name: str, role: str, password: str, actor, request=None):
    if not is_superadmin(actor):
        raise PermissionDenied
    User = get_user_model()
    email = User.objects.normalize_email(email).lower()
    if User.objects.filter(email__iexact=email).exists():
        raise ValidationError({"email": "A user with this email already exists."})
    candidate = User(email=email, full_name=full_name)
    password_validation.validate_password(password, candidate)
    user = User.objects.create_user(email=email, password=password, full_name=full_name)
    record("users.created", request=request, actor=actor, entity=user, summary=f"Created {email}")
    set_role(user, role, actor, request=request)
    return user


@transaction.atomic
def set_active(user, active: bool, actor, request=None) -> None:
    if not is_superadmin(actor):
        raise PermissionDenied
    if user.pk == actor.pk and not active:
        raise ValidationError("You cannot deactivate yourself.")
    if user.is_primary_owner and not active:
        raise ValidationError("The primary owner cannot be deactivated.")
    if user.is_active != active:
        user.is_active = active
        user.save(update_fields=["is_active"])
        action = "users.activated" if active else "users.deactivated"
        record(action, request=request, actor=actor, entity=user, summary=user.email)


# --- Primary owner and one-time set-password links ---------------------------------------------


@transaction.atomic
def ensure_primary_owner(email: str, *, transfer: bool = False):
    """Create (or confirm) the primary owner. Idempotent; never sets or prints a password.

    A new owner gets an unusable password and signs in only after following a one-time link.
    Existing SuperAdmins are left exactly as they are. Moving ownership needs ``transfer=True``.
    Returns ``(user, created, changed)``.
    """
    User = get_user_model()
    email = User.objects.normalize_email(email).strip().lower()
    if not email:
        raise ValidationError("An owner email is required.")
    ensure_roles()
    current = primary_owner()
    if current is not None and current.email != email and not transfer:
        raise ValidationError(
            f"{current.email} is already the primary owner. Pass --transfer to move ownership."
        )
    user = User.objects.filter(email__iexact=email).first()
    created = user is None
    if created:
        user = User.objects.create_superuser(email=email, password=None)  # Unusable password.
        record("users.created", entity=user, summary=f"Created {email} (primary owner)")
    changed = created
    if current is not None and current.pk != user.pk:
        current.is_primary_owner = False
        current.save(update_fields=["is_primary_owner"])
    if not user.is_primary_owner or not user.is_superuser or not user.is_staff or not user.is_active:
        user.is_primary_owner = True
        user.is_superuser = True
        user.is_staff = True
        user.is_active = True
        user.save(update_fields=["is_primary_owner", "is_superuser", "is_staff", "is_active"])
        changed = True
    set_role(user, SUPERADMIN, actor=None)
    if changed:
        record(
            "users.owner_set",
            entity=user,
            summary=f"{email} is the primary owner",
            previous_owner=getattr(current, "email", None),
        )
    return user, created, changed


def setup_link(user, base_url: str, *, request=None, actor=None, reason="setup_link_issued") -> str:
    """A single-use, 30-minute link for ``user`` to set a password. The token is never stored."""
    from django.utils.encoding import force_bytes
    from django.utils.http import urlsafe_base64_encode

    from .tokens import set_password_token

    path = reverse(
        "accounts:set_password",
        kwargs={
            "uidb64": urlsafe_base64_encode(force_bytes(user.pk)),
            "token": set_password_token.make_token(user),
        },
    )
    record(f"auth.{reason}", request=request, actor=actor, entity=user, summary=f"For {user.email}")
    return base_url.rstrip("/") + path


@transaction.atomic
def link_autofix_admin(user, admin_id, actor, request=None) -> bool:
    """Link ``user`` to an Autofix platform admin (or unlink with None). SuperAdmin only, audited.

    The link decides whose name Autofix's own audit logs carry for this person's changes.
    """
    if actor is not None and not is_superadmin(actor):
        raise PermissionDenied
    new = str(admin_id) if admin_id else None
    old = str(user.autofix_admin_id) if user.autofix_admin_id else None
    if new == old:
        return False
    if new and get_user_model().objects.filter(autofix_admin_id=new).exclude(pk=user.pk).exists():
        raise ValidationError("That Autofix platform admin is already linked to another user.")
    user.autofix_admin_id = new
    user.save(update_fields=["autofix_admin_id"])
    record(
        "users.autofix_link_changed",
        request=request,
        actor=actor,
        entity=user,
        summary=f"{user.email}: {'linked to ' + new if new else 'unlinked'}",
        previous=old,
        linked=new,
    )
    return True
