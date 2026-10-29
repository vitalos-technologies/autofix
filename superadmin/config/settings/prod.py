"""Production: every secret and host comes from the environment; fail closed if missing."""

from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import (
    AUTOFIX_DATABASE_URL,
    AUTOFIX_STATUS_TOKEN,
    DATABASES,
    SENTRY_DSN,
    SUPERADMIN_PROXY_SECRET,
    URL_PREFIX,
    env,
)

DEBUG = False
SECRET_KEY = env("DJANGO_SECRET_KEY")
if len(SECRET_KEY) < 50:
    raise ImproperlyConfigured("DJANGO_SECRET_KEY must be at least 50 characters.")
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS")
DATABASES["default"] = env.db("DATABASE_URL")
# Free-tier PostgreSQL behind a pooler: open a fresh connection per request, health-check reused ones,
# and avoid server-side cursors, which transaction pooling does not support.
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=0)
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True
DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = env.bool("DB_DISABLE_SERVER_SIDE_CURSORS", default=True)
APP_ENVIRONMENT = env("APP_ENVIRONMENT", default="production")
AUTOFIX_APP_URL = env("AUTOFIX_APP_URL", default="https://pitline.co.uk").strip().rstrip("/")
AUTOFIX_SUPERADMIN_URL = (
    env("AUTOFIX_SUPERADMIN_URL", default="https://pitline.co.uk/superadmin").strip().rstrip("/")
)
APP_BASE_URL = env("APP_BASE_URL", default=AUTOFIX_SUPERADMIN_URL).rstrip("/")

# Pitline data: Postgres as the least-privilege role, over TLS. An empty URL is allowed (the pages then
# say Pitline data is not connected) so the image can build and run its checks without the secret.
if AUTOFIX_DATABASE_URL:
    if not AUTOFIX_DATABASE_URL.startswith(("postgres://", "postgresql://")):
        raise ImproperlyConfigured("AUTOFIX_DATABASE_URL must be a PostgreSQL URL.")
    # The Supabase pooler names the role "<role>.<project-ref>".
    if (urlsplit(AUTOFIX_DATABASE_URL).username or "").split(".")[0] != "autofix_superadmin":
        raise ImproperlyConfigured("AUTOFIX_DATABASE_URL must sign in as the autofix_superadmin role.")
    _options = DATABASES["autofix"].setdefault("OPTIONS", {})
    _options.setdefault("sslmode", "require")
    # Only the CI container check (Supabase on the same machine) may talk to Pitline without TLS.
    if _options["sslmode"] in ("disable", "allow", "prefer") and urlsplit(
        AUTOFIX_DATABASE_URL
    ).hostname not in (
        "127.0.0.1",
        "localhost",
    ):
        raise ImproperlyConfigured("AUTOFIX_DATABASE_URL must use TLS (sslmode=require or stricter).")
# The hand-off and the status payload's superadminUrl leave only for https.
for _name, _url in (("AUTOFIX_APP_URL", AUTOFIX_APP_URL), ("AUTOFIX_SUPERADMIN_URL", AUTOFIX_SUPERADMIN_URL)):
    if not _url.startswith("https://"):
        raise ImproperlyConfigured(f"{_name} must be https in production.")
if AUTOFIX_STATUS_TOKEN and len(AUTOFIX_STATUS_TOKEN) < 32:
    raise ImproperlyConfigured("AUTOFIX_STATUS_TOKEN must be at least 32 characters.")
# Path mode: only the Pitline proxy, holding the shared secret, may reach the app.
if URL_PREFIX and len(SUPERADMIN_PROXY_SECRET) < 32:
    raise ImproperlyConfigured(
        "SUPERADMIN_PROXY_SECRET (32+ characters) is required with SUPERADMIN_PATH_PREFIX."
    )

# Same origin as the Pitline app: a second factor for every role and a fresh code per sensitive action.
OTP_REQUIRED_FOR_ALL = env.bool("OTP_REQUIRED_FOR_ALL", default=True)
AUTOFIX_STEP_UP = env.bool("AUTOFIX_STEP_UP", default=True)

# TLS terminates at the platform ingress, which sets X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SECURE_REDIRECT_EXEMPT = [r"^healthz/$"]
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=31536000)
# Under a path the host's HSTS policy belongs to the Pitline app; don't widen it from here.
SECURE_HSTS_INCLUDE_SUBDOMAINS = not URL_PREFIX
SECURE_HSTS_PRELOAD = False
# Preload-list submission is a decision for the whole vitalos.co.uk apex, not this subdomain
# (docs/autofix/DECISIONS.md), so its deploy-check warning is acknowledged here.
SILENCED_SYSTEM_CHECKS = ["security.W021"]
if URL_PREFIX:
    SILENCED_SYSTEM_CHECKS.append("security.W005")  # includeSubDomains, see above
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
# __Secure- cookies are refused by browsers unless sent over https with Secure. (__Host- would need
# Path=/, which would hand them to the Pitline app on the same host.) Strict: never sent cross-site.
COOKIE_NAME_PREFIX = "__Secure-"
SESSION_COOKIE_NAME = "__Secure-afsa_session"
CSRF_COOKIE_NAME = "__Secure-afsa_csrftoken"
SESSION_COOKIE_SAMESITE = "Strict"
CSRF_COOKIE_SAMESITE = "Strict"
TRUSTED_PROXY_COUNT = env.int("TRUSTED_PROXY_COUNT", default=1)

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

if SENTRY_DSN:
    import sentry_sdk
    from sentry_sdk.integrations.django import DjangoIntegration

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        integrations=[DjangoIntegration()],
        environment=APP_ENVIRONMENT,
        traces_sample_rate=env.float("SENTRY_TRACES_SAMPLE_RATE", default=0.0),
        send_default_pii=False,
    )
