from csp.constants import UNSAFE_INLINE
from csp.decorators import csp_update
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerSplitView
from rest_framework.routers import DefaultRouter

from . import views

app_name = "api"

router = DefaultRouter()
router.register("garages", views.GarageViewSet, basename="garage")
router.register("domains", views.GarageDomainViewSet, basename="domain")
router.register("jobs", views.JobViewSet, basename="job")

urlpatterns = [
    path("v1/counts/", views.counts, name="counts"),
    path("v1/", include(router.urls)),
    path("schema/", SpectacularAPIView.as_view(), name="schema"),
    # Swagger UI sets inline styles; scripts load from 'self' only (split view, no inline JS).
    path(
        "docs/",
        csp_update({"style-src": [UNSAFE_INLINE]})(
            SpectacularSwaggerSplitView.as_view(url_name="api:schema")
        ),
        name="docs",
    ),
]
