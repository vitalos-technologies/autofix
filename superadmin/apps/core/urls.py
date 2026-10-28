from django.urls import path

from . import views

app_name = "core"

urlpatterns = [
    path("", views.overview, name="overview"),
    path("search/", views.search, name="search"),
    path("palette/", views.palette_results, name="palette"),
    path("help/", views.help_page, name="help"),
    path("system/health/", views.health_page, name="health"),
    path("system/health/footer/", views.health_footer, name="health_footer"),
]
