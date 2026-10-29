"""Roles and access rules. Every server-side authorisation decision goes through this module.

- SuperAdmin: everything, including plan and status changes, job retries, domain re-checks, users.
- Support: reads everything a garage needs help with, the audited personal-data views and "View as
  support" (the read-only hand-off to Pitline). Never changes anything in Pitline.
- Finance: plans, statuses and the sign-up funnel (read). No personal data, no hand-off, no writes.
"""

from functools import wraps

from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied

SUPERADMIN = "SuperAdmin"
SUPPORT = "Support"
FINANCE = "Finance"
ROLES = (SUPERADMIN, SUPPORT, FINANCE)
ROLE_DESCRIPTIONS = {
    SUPERADMIN: "Full control: plans and statuses, job retries, domain re-checks, users and settings.",
    SUPPORT: "Read-only, plus audited customer details on bookings and View as support.",
    FINANCE: "Plans, statuses and the sign-up funnel, read-only. No personal data.",
}
ROLE_LABELS = {SUPERADMIN: "Super admin", SUPPORT: "Support", FINANCE: "Finance"}


def user_roles(user) -> frozenset[str]:
    """Role names held by ``user``; Django superusers are always SuperAdmin."""
    if user is None or not user.is_authenticated or not user.is_active:
        return frozenset()
    cached = getattr(user, "_afsa_roles", None)
    if cached is None:
        names = set(user.groups.filter(name__in=ROLES).values_list("name", flat=True))
        if user.is_superuser:
            names.add(SUPERADMIN)
        cached = frozenset(names)
        user._afsa_roles = cached
    return cached


def clear_role_cache(user) -> None:
    if hasattr(user, "_afsa_roles"):
        del user._afsa_roles


def primary_role(user) -> str | None:
    roles = user_roles(user)
    return next((role for role in ROLES if role in roles), None)


def role_label(user) -> str:
    """Human label for the user menu, e.g. "Owner · Super admin" for the primary owner."""
    role = primary_role(user)
    label = ROLE_LABELS.get(role, "No role")
    return f"Owner · {label}" if getattr(user, "is_primary_owner", False) else label


def is_superadmin(user) -> bool:
    return SUPERADMIN in user_roles(user)


def has_role(user, *roles: str) -> bool:
    """True when the user holds any of ``roles``. SuperAdmin satisfies every role check."""
    held = user_roles(user)
    return bool(held) and (SUPERADMIN in held or bool(held.intersection(roles)))


def has_any_role(user) -> bool:
    return bool(user_roles(user))


def can_support(user) -> bool:
    """Personal data on audited views and the View as support hand-off."""
    return has_role(user, SUPPORT)


def can_operate(user) -> bool:
    """Operational pages (jobs, messaging, domains): SuperAdmin and Support."""
    return has_role(user, SUPPORT)


def can_change_autofix(user) -> bool:
    """Writes through the platform functions. The view also needs a verified device and a link."""
    return is_superadmin(user)


def role_required(*roles: str):
    """View decorator: anonymous users go to login; authenticated users without a role get 403."""

    def decorator(view_func):
        @wraps(view_func)
        def wrapped(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return redirect_to_login(request.get_full_path())
            allowed = has_role(request.user, *roles) if roles else has_any_role(request.user)
            if not allowed:
                raise PermissionDenied
            return view_func(request, *args, **kwargs)

        return wrapped

    return decorator
