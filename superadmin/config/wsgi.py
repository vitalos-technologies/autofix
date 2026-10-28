import os

from django.conf import settings
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")
application = get_wsgi_application()

from apps.core.wsgi import PrefixMiddleware  # noqa: E402 - needs the settings loaded above

application = PrefixMiddleware(application, settings.URL_PREFIX)
