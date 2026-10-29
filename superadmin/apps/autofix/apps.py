from django.apps import AppConfig


class AutofixConfig(AppConfig):
    name = "apps.autofix"
    label = "autofix"
    verbose_name = "Autofix (read-only)"

    def ready(self):
        from apps.core import palette

        from . import search

        palette.register(search.palette_results)
        palette.register(search.enquiry_results)
