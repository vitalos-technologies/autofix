from rest_framework.permissions import SAFE_METHODS, BasePermission

from apps.accounts.roles import has_any_role


class HasAnyRole(BasePermission):
    """Authenticated users holding a role, read-only methods only."""

    message = "A super admin role is required and the API is read-only."

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and has_any_role(user) and request.method in SAFE_METHODS)
