"""Local development: SQLite by default, DEBUG on, readable logs."""

import secrets

from .base import *  # noqa: F403
from .base import BASE_DIR, LOGGING, env

DEBUG = env.bool("DJANGO_DEBUG", default=True)
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1", "[::1]"])
CSRF_TRUSTED_ORIGINS = env.list(
    "CSRF_TRUSTED_ORIGINS", default=["http://localhost:8000", "http://127.0.0.1:8000"]
)


def _local_secret_key() -> str:
    """Keep a per-checkout random key in an ignored file so sessions survive restarts."""
    path = BASE_DIR / ".dev_secret_key"
    try:
        if not path.exists():
            path.write_text(secrets.token_urlsafe(50))
        return path.read_text().strip()
    except OSError:  # read-only checkout (e.g. a container mount): sessions reset on restart
        return secrets.token_urlsafe(50)


SECRET_KEY = env("DJANGO_SECRET_KEY", default="") or _local_secret_key()
LOGGING["handlers"]["console"]["formatter"] = env("LOG_FORMAT", default="text")
# Serve static files straight from app/static directories while developing.
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True
