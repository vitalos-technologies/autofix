"""The write gateway: an allowlist of platform functions, run as the linked platform admin."""

from unittest import mock

import pytest
from django.db import DatabaseError

from apps.autofix import db


def test_only_the_four_platform_functions_are_allowed():
    assert set(db.PLATFORM_FUNCTIONS) == {
        "platform_update_garage",
        "platform_retry_job",
        "platform_request_domains_check",
        "platform_update_enquiry",
    }
    for name in ("enqueue_job", "create_booking", "platform_start_impersonation", "x; drop table jobs"):
        with pytest.raises(ValueError):
            db.call_platform_function(name, [], actor_id="5a000000-0000-4000-8000-0000000000a1")


def test_argument_count_is_checked():
    with pytest.raises(ValueError):
        db.call_platform_function(
            "platform_retry_job", ["only-one"], actor_id="5a000000-0000-4000-8000-0000000000a1"
        )


def test_actor_must_be_a_uuid():
    with pytest.raises(ValueError):
        db.call_platform_function("platform_retry_job", ["a", "b"], actor_id="not-a-uuid")


def test_not_configured_refuses(settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function(
            "platform_retry_job", ["a", "b"], actor_id="5a000000-0000-4000-8000-0000000000a1"
        )
    assert error.value.code == "NOT_CONFIGURED"


class FakeCursor:
    def __init__(self, fail=None, result=('{"ok": true}',)):
        self.executed = []
        self.fail = fail
        self.result = result

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if self.fail and sql.startswith("SELECT public."):
            raise self.fail

    def fetchone(self):
        return self.result


def _run_with(cursor):
    connection = mock.MagicMock()
    connection.in_atomic_block = False
    connection.cursor.return_value = cursor
    with (
        mock.patch.object(db, "connections", {"autofix": connection}),
        mock.patch.object(db.transaction, "atomic", mock.MagicMock()),
    ):
        return db.call_platform_function(
            "platform_update_garage",
            ["g", "growth", None, "A good reason"],
            actor_id="5a000000-0000-4000-8000-0000000000a1",
        )


def test_claims_are_set_in_a_read_write_transaction_before_the_call():
    cursor = FakeCursor()
    assert _run_with(cursor) == {"ok": True}
    statements = [sql for sql, _ in cursor.executed]
    assert statements[0] == "SET TRANSACTION READ WRITE"
    assert "set_config('request.jwt.claims'" in statements[1]
    claims = cursor.executed[1][1][0]
    assert '"sub": "5a000000-0000-4000-8000-0000000000a1"' in claims and '"aal": "aal2"' in claims
    assert statements[2] == "SELECT public.platform_update_garage(%s, %s, %s, %s)"
    assert cursor.executed[2][1] == ["g", "growth", None, "A good reason"]


def test_database_refusals_become_platform_errors_with_the_code():
    cause = Exception("PLATFORM_ADMIN_REQUIRED")
    error = DatabaseError("refused")
    error.__cause__ = cause
    with pytest.raises(db.PlatformError) as raised:
        _run_with(FakeCursor(fail=error))
    assert raised.value.code == "PLATFORM_ADMIN_REQUIRED"


def test_unknown_database_errors_get_a_generic_code():
    error = DatabaseError("something odd happened")
    with pytest.raises(db.PlatformError) as raised:
        _run_with(FakeCursor(fail=error))
    assert raised.value.code == "DATABASE_ERROR"


def test_reads_decorator_turns_database_errors_into_unavailable():
    @db.reads
    def broken():
        raise DatabaseError("down")

    with pytest.raises(db.AutofixUnavailable) as error:
        broken()
    assert str(error.value) == "unavailable"


def test_reads_decorator_refuses_when_not_configured(settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False

    @db.reads
    def fine():
        return 1

    with pytest.raises(db.AutofixUnavailable) as error:
        fine()
    assert str(error.value) == "not_configured"


def test_using_alias_switches_reads_and_restores():
    assert db.current_alias() == "autofix"
    with db.using_alias("autofix_live"):
        assert db.current_alias() == "autofix_live"
    assert db.current_alias() == "autofix"
