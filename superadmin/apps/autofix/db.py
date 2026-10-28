"""The only write path to Autofix: the platform SQL functions, called as a linked platform admin.

Every Autofix rule stays in Autofix's database. Each function checks that ``auth.uid()`` is a platform
admin at AAL2, validates the reason and writes ``platform_audit_log`` and the garage's own audit log.
The super admin connects as ``autofix_superadmin`` (SELECT on views, EXECUTE on the three functions
below, read-only sessions by default). For a write it opens a read-write transaction, sets
``request.jwt.claims`` for the signed-in Vitalos user's linked platform admin (whose second factor
Django has just verified) and calls one function. Nothing else can be called from here.
"""

import json
import logging
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

from django.conf import settings
from django.db import DatabaseError, connections, transaction

logger = logging.getLogger(__name__)

ALIAS = "autofix"
# Function name -> number of arguments. The SQL is built only from this allowlist.
PLATFORM_FUNCTIONS = {
    "platform_update_garage": 4,
    "platform_retry_job": 2,
    "platform_request_domains_check": 2,
}
_alias: ContextVar[str] = ContextVar("autofix_alias", default=ALIAS)


class AutofixUnavailable(Exception):
    """Autofix data could not be read (not configured, unreachable, or a query failed)."""


class PlatformError(Exception):
    """A platform function refused the change. ``code`` is the database's error code word."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def current_alias() -> str:
    return _alias.get()


@contextmanager
def using_alias(alias: str):
    """Point reads and calls at another configured connection (integration tests only)."""
    token = _alias.set(alias)
    try:
        yield
    finally:
        _alias.reset(token)


def is_configured() -> bool:
    return bool(getattr(settings, "AUTOFIX_DATABASE_CONFIGURED", False))


def reads(func):
    """Selector decorator: any database failure becomes ``AutofixUnavailable`` (the page says so)."""

    @wraps(func)
    def wrapper(*args, **kwargs):
        if not is_configured():
            raise AutofixUnavailable("not_configured")
        try:
            return func(*args, **kwargs)
        except DatabaseError as exc:
            logger.warning(
                "Autofix read failed", extra={"selector": func.__name__, "error": type(exc).__name__}
            )
            raise AutofixUnavailable("unavailable") from exc

    return wrapper


def _error_code(exc: Exception) -> str:
    cause = exc.__cause__ or exc
    diag = getattr(cause, "diag", None)
    primary = getattr(diag, "message_primary", None) or str(cause)
    word = (primary or "").split(":", 1)[0].strip().split()[0] if primary else ""
    return word if word.replace("_", "").isalnum() and word.upper() == word else "DATABASE_ERROR"


def call_platform_function(name: str, args: list, *, actor_id: uuid.UUID | str):
    """Run one allowlisted platform function as ``actor_id`` and return its single result value."""
    if name not in PLATFORM_FUNCTIONS or len(args) != PLATFORM_FUNCTIONS[name]:
        raise ValueError(f"{name} is not a platform function the super admin may call.")
    if not is_configured():
        raise PlatformError("NOT_CONFIGURED", "Autofix data is not connected.")
    actor = str(uuid.UUID(str(actor_id)))
    claims = json.dumps({"sub": actor, "role": "authenticated", "aal": "aal2"})
    alias = current_alias()
    connection = connections[alias]
    if connection.in_atomic_block:
        raise RuntimeError("Platform functions run in their own transaction.")
    placeholders = ", ".join(["%s"] * len(args))
    try:
        with transaction.atomic(using=alias), connection.cursor() as cursor:
            # The role's sessions are read-only by default: only this transaction may write.
            cursor.execute("SET TRANSACTION READ WRITE")
            cursor.execute("SELECT set_config('request.jwt.claims', %s, true)", [claims])
            cursor.execute(f"SELECT public.{name}({placeholders})", args)  # noqa: S608  # nosec B608
            row = cursor.fetchone()
    except DatabaseError as exc:
        code = _error_code(exc)
        logger.warning("Platform function refused", extra={"function": name, "code": code})
        raise PlatformError(code) from exc
    value = row[0] if row else None
    if isinstance(value, str) and value[:1] in "{[":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value
