from django.contrib import admin
from django.urls import include, path

from apps.autofix.views.operations import product_status

urlpatterns = [
    path("django-admin/", admin.site.urls),
    path("api/platform/v1/status", product_status, name="product_status"),
    path("", include("apps.accounts.urls")),
    path("", include("apps.core.urls")),
    path("", include("apps.autofix.urls")),
    path("notifications/", include("apps.notifications.urls")),
    path("audit/", include("apps.audit.urls")),
    path("api/", include("apps.api.urls")),
]

handler403 = "apps.core.views.permission_denied"
handler404 = "apps.core.views.page_not_found"
handler500 = "apps.core.views.server_error"
