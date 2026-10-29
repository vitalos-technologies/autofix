from urllib.parse import urlencode

from csp.constants import UNSAFE_INLINE
from csp.decorators import csp_update
from django.contrib import admin
from django.core.exceptions import PermissionDenied
from django.http import HttpResponseRedirect
from django.urls import reverse


class SuperuserAdminSite(admin.AdminSite):
    """Django admin for superusers with a verified second factor only.

    This is the only place records can be hard-deleted; the application UI archives instead.
    """

    site_header = "Pitline Super Admin — Django admin"
    site_title = "Pitline Django admin"
    index_title = "Data administration (superusers only)"

    def admin_view(self, view, cacheable=False):
        # Django admin and simple-history templates use inline style attributes; scripts stay
        # nonce/self-only. The admin is reachable only by verified superusers.
        return csp_update({"style-src": [UNSAFE_INLINE]})(super().admin_view(view, cacheable))

    def has_permission(self, request):
        user = request.user
        if not (user.is_active and user.is_superuser):
            return False
        is_verified = getattr(user, "is_verified", None)
        return bool(is_verified and is_verified())

    def login(self, request, extra_context=None):
        if request.user.is_authenticated:
            # Signed in but not a verified superuser: refuse rather than loop through the login page.
            raise PermissionDenied
        target = request.GET.get("next") or reverse("admin:index")
        return HttpResponseRedirect(f"{reverse('accounts:login')}?{urlencode({'next': target})}")
