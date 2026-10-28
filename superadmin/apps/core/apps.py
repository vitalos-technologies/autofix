from django.apps import AppConfig
from django.contrib.admin import apps as admin_apps


class CoreConfig(AppConfig):
    default = True
    name = "apps.core"
    label = "core"
    verbose_name = "Core"


class SuperAdminSiteConfig(admin_apps.AdminConfig):
    """Replace the default admin site with one restricted to verified superusers."""

    default = False
    default_site = "apps.core.admin_site.SuperuserAdminSite"
