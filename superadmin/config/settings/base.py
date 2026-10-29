"""Settings shared by every environment. Secrets and hosts come only from the environment."""

import re
from datetime import timedelta
from pathlib import Path

import environ
from csp.constants import NONCE, NONE, SELF
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
if (BASE_DIR / ".env").is_file():
    environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("DJANGO_SECRET_KEY", default="")
DEBUG = False
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])
APP_ENVIRONMENT = env("APP_ENVIRONMENT", default="development")

# --- Path mode (DECISIONS D18) -------------------------------------------------------------------
# Production serves the super admin at https://pitline.co.uk/superadmin: the Pitline app's
# proxy (src/proxy.ts) forwards /superadmin/* here with a shared secret header. Empty prefix: the app
# answers at the root of its own host (local development, tests).
URL_PREFIX = env("SUPERADMIN_PATH_PREFIX", default="").strip().rstrip("/")
if URL_PREFIX and not re.fullmatch(r"(/[a-z0-9-]+)+", URL_PREFIX):
    raise ImproperlyConfigured("SUPERADMIN_PATH_PREFIX must look like /superadmin.")
# Django builds every URL (reverse, static, redirects) under the prefix; config/wsgi.py strips it.
FORCE_SCRIPT_NAME = URL_PREFIX or None
# Shared secret the proxy sends in X-Autofix-Superadmin-Proxy. Set: every request without it gets a
# bare 404 (apps.core.middleware.ProxyGateMiddleware), so the origin cannot be used directly.
SUPERADMIN_PROXY_SECRET = env("SUPERADMIN_PROXY_SECRET", default="")

INSTALLED_APPS = [
    "apps.core.apps.SuperAdminSiteConfig",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",
    "django_htmx",
    "simple_history",
    "axes",
    "django_otp",
    "django_otp.plugins.otp_totp",
    "csp",
    "rest_framework",
    "drf_spectacular",
    "drf_spectacular_sidecar",
    "apps.core",
    "apps.audit",
    "apps.accounts",
    "apps.notifications",
    "apps.autofix",
    "apps.api",
]

MIDDLEWARE = [
    "apps.core.middleware.ProxyGateMiddleware",
    "apps.core.middleware.HealthCheckMiddleware",
    "apps.core.middleware.RequestIDMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "apps.core.middleware.SecurityHeadersMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django_otp.middleware.OTPMiddleware",
    "apps.accounts.middleware.OTPEnforcementMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "csp.middleware.CSPMiddleware",
    "django_htmx.middleware.HtmxMiddleware",
    "simple_history.middleware.HistoryRequestMiddleware",
    "axes.middleware.AxesMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "apps.core.context_processors.app_context",
            ],
        },
    },
]


def autofix_database(url: str) -> dict:
    """The ``autofix`` alias: Pitline's Supabase Postgres as the ``autofix_superadmin`` role.

    Read-only by default (the role's own default too); writes open ``SET TRANSACTION READ WRITE`` and
    go only through the platform functions (``apps.autofix.db``). Reads use schema ``superadmin``.
    """
    config = env.db_url_config(url)
    config["CONN_MAX_AGE"] = env.int("AUTOFIX_DB_CONN_MAX_AGE", default=0)
    config["CONN_HEALTH_CHECKS"] = True
    if config["ENGINE"] == "django.db.backends.postgresql":
        options = config.setdefault("OPTIONS", {})
        if env.bool("AUTOFIX_DB_STARTUP_OPTIONS", default=True):
            # Mirrors the role's defaults (migration 20261028004000); a pooler may drop startup options.
            options["options"] = (
                "-c default_transaction_read_only=on -c search_path=superadmin -c statement_timeout=10000"
            )
        options.setdefault("application_name", "autofix-superadmin")
        config["DISABLE_SERVER_SIDE_CURSORS"] = True
    return config


DATABASES = {"default": env.db("DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}")}
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True
# Empty: Pitline pages say "Pitline data is not connected" (a placeholder SQLite file with no tables).
AUTOFIX_DATABASE_URL = env("AUTOFIX_DATABASE_URL", default="")
AUTOFIX_DATABASE_CONFIGURED = bool(AUTOFIX_DATABASE_URL)
DATABASES["autofix"] = autofix_database(
    AUTOFIX_DATABASE_URL or f"sqlite:///{BASE_DIR / 'autofix-not-configured.sqlite3'}"
)
DATABASE_ROUTERS = ["apps.autofix.router.AutofixRouter"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = [
    "axes.backends.AxesStandaloneBackend",
    "django.contrib.auth.backends.ModelBackend",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LOGIN_URL = "accounts:login"
LOGIN_REDIRECT_URL = "core:overview"
LOGOUT_REDIRECT_URL = "accounts:login"

# Sessions: 8 hour absolute lifetime, HTTP-only cookies scoped to the prefix, so the Pitline app on
# the same host never receives them (and the proxy forwards only these cookies here).
COOKIE_PATH = f"{URL_PREFIX}/"
COOKIE_NAME_PREFIX = ""  # "__Secure-" in production
SESSION_COOKIE_AGE = 8 * 60 * 60
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_NAME = "afsa_session"
SESSION_COOKIE_PATH = COOKIE_PATH
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_NAME = "afsa_csrftoken"
CSRF_COOKIE_PATH = COOKIE_PATH

# django-axes: lock an email+IP combination after repeated failures.
AXES_FAILURE_LIMIT = env.int("AXES_FAILURE_LIMIT", default=5)
AXES_COOLOFF_TIME = timedelta(minutes=env.int("AXES_COOLOFF_MINUTES", default=30))
AXES_LOCKOUT_PARAMETERS = [["username", "ip_address"]]
AXES_USERNAME_FORM_FIELD = "email"
AXES_RESET_ON_SUCCESS = True
AXES_LOCKOUT_TEMPLATE = "accounts/lockout.html"
AXES_CLIENT_IP_CALLABLE = "apps.core.http.client_ip"
AXES_SENSITIVE_PARAMETERS = ["password"]
# Number of trusted reverse proxies in front of the app (Azure Container Apps ingress = 1).
TRUSTED_PROXY_COUNT = env.int("TRUSTED_PROXY_COUNT", default=0)

# django-otp: TOTP is mandatory for SuperAdmin and for anyone who enrolled a device. Pitline writes
# (plan, status, retries, re-checks) also need a verified device, whatever the role.
OTP_TOTP_ISSUER = "Pitline Super Admin"
OTP_REQUIRED_FOR_SUPERADMIN = env.bool("OTP_REQUIRED_FOR_SUPERADMIN", default=True)
# Every role, not just SuperAdmin (production default: the app shares an origin with Pitline).
OTP_REQUIRED_FOR_ALL = env.bool("OTP_REQUIRED_FOR_ALL", default=False)
# A fresh authenticator code with each change to Pitline, each personal-data view, user changes and
# API token creation (apps.accounts.stepup). Production default: on.
AUTOFIX_STEP_UP = env.bool("AUTOFIX_STEP_UP", default=False)

APP_BASE_URL = env("APP_BASE_URL", default="http://localhost:8000").rstrip("/")
PRIMARY_OWNER_EMAIL = env("PRIMARY_OWNER_EMAIL", default="").strip().lower()
# Pre-fills the sign-in email when set. Empty by default: pre-filling a public page reveals the login.
DEFAULT_SIGNIN_EMAIL = env("DEFAULT_SIGNIN_EMAIL", default="").strip().lower()
# This app sends no email (no messages to people). Passwords are set with `issue_setup_link`.
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# --- Pitline ------------------------------------------------------------------------------------
# The Pitline app (Next.js) for the "View as support" hand-off: the read-only session itself starts
# there, under the admin's own Pitline sign-in and MFA. Nothing is appended but the garage's id.
AUTOFIX_APP_URL = env("AUTOFIX_APP_URL", default="http://localhost:3000").strip().rstrip("/")
# This super admin's public address, returned as ``superadminUrl`` by the product status endpoint.
AUTOFIX_SUPERADMIN_URL = env("AUTOFIX_SUPERADMIN_URL", default=APP_BASE_URL).strip().rstrip("/")
# Bearer token the Vitalos Product Pipeline sends to GET /api/platform/v1/status (ADR-044).
# Empty: the endpoint answers 503 and reveals nothing. A secret: set only in the platform's store.
AUTOFIX_STATUS_TOKEN = env("AUTOFIX_STATUS_TOKEN", default="")
AUTOFIX_TIME_ZONE = "Europe/London"
# Voicemail playback (Calls): the Twilio account Pitline records voicemails on. Recordings need the
# account's credentials, so the super admin fetches them server-side; the browser never gets the
# Twilio link. Empty: playback says it is not configured. Secrets: set only in the platform's store.
TWILIO_ACCOUNT_SID = env("TWILIO_ACCOUNT_SID", default="").strip()
TWILIO_AUTH_TOKEN = env("TWILIO_AUTH_TOKEN", default="").strip()
# Onboarding counts as stuck after this many hours (Overview, Sign-ups).
ONBOARDING_STUCK_HOURS = env.int("ONBOARDING_STUCK_HOURS", default=48)

LANGUAGE_CODE = "en-gb"
TIME_ZONE = "Europe/London"
USE_I18N = True
USE_TZ = True

# Under the prefix (/superadmin/static/); WhiteNoise strips FORCE_SCRIPT_NAME to match path_info.
STATIC_URL = f"{URL_PREFIX}/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024

# Security headers that are safe in every environment.
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# Strict CSP: no inline script or style without the per-request nonce.
CONTENT_SECURITY_POLICY = {
    "DIRECTIVES": {
        "default-src": [NONE],
        "script-src": [SELF, NONCE],
        "style-src": [SELF, NONCE],
        "img-src": [SELF, "data:"],
        # Voicemails, streamed by the super admin's own proxy (never from Twilio directly).
        "media-src": [SELF],
        "font-src": [SELF],
        "connect-src": [SELF],
        "manifest-src": [SELF],
        "frame-src": [NONE],
        "form-action": [SELF],
        "frame-ancestors": [NONE],
        "base-uri": [NONE],
        "object-src": [NONE],
    },
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.api.authentication.ApiTokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["apps.api.permissions.HasAnyRole"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"user": "600/hour"},
}
SPECTACULAR_SETTINGS = {
    "TITLE": "Pitline Super Admin API",
    "DESCRIPTION": "Read-only API over Pitline garages, domains and jobs. No personal data. "
    "Authenticate with `Authorization: Bearer <token>` using a token from Settings → API tokens.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "SERVE_PERMISSIONS": ["apps.api.permissions.HasAnyRole"],
    "SWAGGER_UI_DIST": "SIDECAR",
    "SWAGGER_UI_FAVICON_HREF": "SIDECAR",
    "REDOC_DIST": "SIDECAR",
    "COMPONENT_SPLIT_REQUEST": True,
    "ENUM_NAME_OVERRIDES": {
        "GarageStatusEnum": "apps.autofix.models.GARAGE_STATUSES",
        "DomainStatusEnum": "apps.autofix.models.DOMAIN_STATUSES",
        "JobStatusEnum": "apps.autofix.models.JOB_STATUSES",
    },
}

SIMPLE_HISTORY_REVERT_DISABLED = True
SIMPLE_HISTORY_HISTORY_CHANGE_REASON_USE_TEXT_FIELD = True

# Logging: JSON lines with request IDs by default; LOG_FORMAT=text for local readability.
LOG_LEVEL = env("LOG_LEVEL", default="INFO")
LOG_FORMAT = env("LOG_FORMAT", default="json")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"request_id": {"()": "apps.core.logging.RequestIDFilter"}},
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.json.JsonFormatter",
            "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s %(request_id)s",
            "rename_fields": {"asctime": "timestamp", "levelname": "level", "name": "logger"},
        },
        "text": {"format": "%(asctime)s %(levelname)-7s [%(request_id)s] %(name)s: %(message)s"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": LOG_FORMAT if LOG_FORMAT in ("json", "text") else "json",
            "filters": ["request_id"],
        }
    },
    "root": {"handlers": ["console"], "level": LOG_LEVEL},
    "loggers": {
        "django": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
        "django.server": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "axes": {"handlers": ["console"], "level": "WARNING", "propagate": False},
    },
}

SENTRY_DSN = env("SENTRY_DSN", default="")
