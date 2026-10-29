"""Test settings: fast hashing, isolated databases (SQLite unless DATABASE_URL / AUTOFIX_TEST_DATABASE_URL).

The ``autofix`` alias gets its own test database; ``tests/conftest.py`` creates the tables of the
unmanaged Autofix models in it (the router never migrates that alias).
"""

from django.core.management.utils import get_random_secret_key

from .base import *  # noqa: F403
from .base import BASE_DIR, LOGGING, MIDDLEWARE, autofix_database, env

SECRET_KEY = get_random_secret_key()
DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost"]
DATABASES = {
    "default": env.db("DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'test.sqlite3'}"),
    "autofix": autofix_database(
        env("AUTOFIX_TEST_DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'test-autofix.sqlite3'}")
    ),
}
# Integration tests (pytest -m integration) talk to the local Supabase as autofix_superadmin. The alias
# is never set up as a test database: no unit test asks for it.
if env("AUTOFIX_LIVE_DATABASE_URL", default=""):
    DATABASES["autofix_live"] = autofix_database(env("AUTOFIX_LIVE_DATABASE_URL"))
# The test database is created by the test runner as a superuser-ish role: no read-only startup options.
DATABASES["autofix"].get("OPTIONS", {}).pop("options", None)
AUTOFIX_DATABASE_CONFIGURED = True
# Lets the test runner create the empty autofix test database (the router still skips every model).
AUTOFIX_MIGRATE_GUARD = False
# The test database is written by the fixtures, so its sessions are not read-only.
AUTOFIX_EXPECT_READ_ONLY = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
# No status token or external URLs unless a test sets them (a developer's .env must not leak in).
# Empty: the status endpoint is off.
AUTOFIX_STATUS_TOKEN = ""  # noqa: S105  # nosec B105
TWILIO_ACCOUNT_SID = ""
TWILIO_AUTH_TOKEN = ""  # noqa: S105  # nosec B105
AUTOFIX_APP_URL = "https://autofix.example.test"
AUTOFIX_SUPERADMIN_URL = "https://superadmin.autofix.example.test"
APP_ENVIRONMENT = "test"
LOGGING["handlers"]["console"]["formatter"] = "text"
LOGGING["root"]["level"] = "WARNING"
LOGGING["loggers"]["django"]["level"] = "ERROR"
REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_CLASSES": []}  # noqa: F405
# Static files are served by Django's test client finders; WhiteNoise needs a collected STATIC_ROOT.
MIDDLEWARE = [entry for entry in MIDDLEWARE if "whitenoise" not in entry]
