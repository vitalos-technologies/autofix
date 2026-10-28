"""Against the local Supabase (supabase start; supabase db reset): the autofix_superadmin role and the
write path through the real platform functions.

    AUTOFIX_LIVE_DATABASE_URL=postgres://autofix_superadmin:<password>@127.0.0.1:54322/postgres \
    AUTOFIX_LIVE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
    pytest -m integration

The admin URL only sets up and removes fixture rows; every assertion runs as autofix_superadmin.
"""

import os
import uuid

import psycopg
import pytest
from django.db import connections

from apps.autofix import db, selectors

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (os.environ.get("AUTOFIX_LIVE_DATABASE_URL") and os.environ.get("AUTOFIX_LIVE_ADMIN_URL")),
        reason="needs AUTOFIX_LIVE_DATABASE_URL and AUTOFIX_LIVE_ADMIN_URL (local Supabase)",
    ),
]

ADMIN = uuid.UUID("5a000000-0000-4000-8000-00000000a1f1")
GARAGE = uuid.UUID("5a000000-0000-4000-8000-00000000a1f2")
DOMAIN = uuid.UUID("5a000000-0000-4000-8000-00000000a1f3")
JOB = uuid.UUID("5a000000-0000-4000-8000-00000000a1f4")


def role():
    return psycopg.connect(os.environ["AUTOFIX_LIVE_DATABASE_URL"], autocommit=True)


@pytest.fixture(scope="module")
def admin_rows():
    with psycopg.connect(os.environ["AUTOFIX_LIVE_ADMIN_URL"], autocommit=True) as conn:
        conn.execute(
            "insert into auth.users (id, email, raw_user_meta_data) values (%s, 'sa-integration@vitalos.example', '{}') on conflict do nothing",
            [ADMIN],
        )
        conn.execute(
            "insert into public.platform_admins (user_id) values (%s) on conflict do nothing", [ADMIN]
        )
        conn.execute(
            "insert into public.garages (id, slug, name, booking_prefix, plan, status) values "
            "(%s, 'sa-integration', 'SA Integration Garage', 'SAI', 'trial', 'active')",
            [GARAGE],
        )
        conn.execute(
            "insert into public.garage_domains (id, garage_id, hostname, kind, status) values "
            "(%s, %s, 'book.sa-integration.example', 'custom', 'verifying')",
            [DOMAIN, GARAGE],
        )
        conn.execute(
            "insert into public.jobs (id, kind, garage_id, status, attempts, finished_at, last_error) values "
            "(%s, 'sa.integration', %s, 'failed', 5, now(), 'boom for AB12 CDE')",
            [JOB, GARAGE],
        )
        yield conn
        conn.execute(
            "delete from public.jobs where garage_id = %s or kind = 'domains.check' and dedupe_key like 'domains.check:platform:%%'",
            [GARAGE],
        )
        conn.execute("delete from public.garages where id = %s", [GARAGE])
        conn.execute("delete from public.platform_audit_log where actor_id = %s", [ADMIN])
        conn.execute("delete from public.platform_admins where user_id = %s", [ADMIN])
        conn.execute("delete from auth.users where id = %s", [ADMIN])


@pytest.fixture
def live(django_db_blocker, settings, admin_rows):
    settings.AUTOFIX_DATABASE_CONFIGURED = True
    with django_db_blocker.unblock(), db.using_alias("autofix_live"):
        yield connections["autofix_live"]


def test_sessions_are_read_only_with_the_superadmin_search_path(admin_rows):
    with role() as conn:
        assert conn.execute("show transaction_read_only").fetchone()[0] == "on"
        assert conn.execute("show search_path").fetchone()[0] == "superadmin"


@pytest.mark.parametrize(
    "view",
    [
        "garages",
        "garage_members",
        "garage_invites",
        "admin_profiles",
        "platform_admins",
        "customers",
        "vehicles",
        "services",
        "resources",
        "bookings",
        "garage_domains",
        "jobs",
        "reminder_sends",
        "messages",
        "calls",
        "garage_agreements",
        "platform_audit_log",
        "platform_impersonations",
    ],
)
def test_role_reads_every_view(admin_rows, view):
    with role() as conn:
        conn.execute(f"select * from superadmin.{view} limit 1")  # noqa: S608


@pytest.mark.parametrize(
    "table", ["garages", "customers", "bookings", "messages", "jobs", "platform_audit_log"]
)
def test_role_cannot_read_public_tables(admin_rows, table):
    with role() as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(f"select 1 from public.{table} limit 1")  # noqa: S608


def test_role_cannot_write_views_even_in_a_read_write_transaction(admin_rows):
    with role() as conn:
        conn.autocommit = False
        conn.execute("set transaction read write")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update superadmin.garages set name = 'x'")
        conn.rollback()


def test_default_read_only_session_refuses_function_writes(admin_rows):
    with role() as conn, pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        conn.execute(
            "select set_config('request.jwt.claims', %s, false)",
            [f'{{"sub":"{ADMIN}","role":"authenticated","aal":"aal2"}}'],
        )
        conn.execute("select public.platform_update_garage(%s, 'growth', null, 'read only test')", [GARAGE])


@pytest.mark.parametrize(
    "call",
    [
        "select public.enqueue_job('x', '{}'::jsonb)",
        "select public.create_booking('00000000-0000-4000-8000-000000000000'::uuid, '{}'::jsonb)",
        "select public.platform_start_impersonation('00000000-0000-4000-8000-000000000000'::uuid, 'reason here', 30)",
        "select public.claim_jobs('x', 1)",
    ],
)
def test_role_cannot_call_other_functions(admin_rows, call):
    with role() as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(call)


def test_contact_details_and_registrations_arrive_masked(admin_rows):
    with role() as conn:
        cols = {
            row[0]
            for row in conn.execute(
                "select column_name from information_schema.columns where table_schema = 'superadmin' and table_name = 'customers'"
            )
        }
        assert "phone" not in cols and "email" not in cols and "phone_masked" in cols
        message_cols = {
            row[0]
            for row in conn.execute(
                "select column_name from information_schema.columns where table_schema = 'superadmin' and table_name = 'messages'"
            )
        }
        assert not {"body", "to_address", "from_address"} & message_cols


def test_selectors_read_through_the_role(live):
    counts = selectors.garage_counts()
    assert counts["total"] >= 1
    assert selectors.garage(GARAGE).name == "SA Integration Garage"
    assert any(item.key == f"job:{JOB}" for item in selectors.attention_items(limit=50))


def test_plan_change_goes_through_platform_update_garage(live, admin_rows):
    result = db.call_platform_function(
        "platform_update_garage",
        [str(GARAGE), "growth", None, "Integration test plan change"],
        actor_id=ADMIN,
    )
    assert result["plan"] == "growth"
    entry = admin_rows.execute(
        "select action, reason from public.platform_audit_log where target_garage_id = %s order by id desc limit 1",
        [GARAGE],
    ).fetchone()
    assert entry == ("platform.garage_plan_changed", "Integration test plan change")
    garage_log = admin_rows.execute(
        "select count(*) from public.admin_audit_log where garage_id = %s and action = 'platform.garage_plan_changed'",
        [GARAGE],
    ).fetchone()[0]
    assert garage_log == 1


def test_a_non_admin_actor_is_refused(live):
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function(
            "platform_update_garage", [str(GARAGE), "trial", None, "Should be refused"], actor_id=uuid.uuid4()
        )
    assert error.value.code == "PLATFORM_ADMIN_REQUIRED"


def test_short_reason_is_refused_by_the_database(live):
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function(
            "platform_update_garage", [str(GARAGE), "trial", None, "no"], actor_id=ADMIN
        )
    assert error.value.code == "INVALID_REASON"


def test_job_retry_and_domain_check(live, admin_rows):
    assert (
        db.call_platform_function("platform_retry_job", [str(JOB), "Integration retry"], actor_id=ADMIN)
        is True
    )
    status = admin_rows.execute("select status, attempts from public.jobs where id = %s", [JOB]).fetchone()
    assert status == ("queued", 0)
    first = db.call_platform_function(
        "platform_request_domains_check", [str(DOMAIN), "Integration re-check"], actor_id=ADMIN
    )
    second = db.call_platform_function(
        "platform_request_domains_check", [str(DOMAIN), "Integration re-check"], actor_id=ADMIN
    )
    assert first["job_id"] == second["job_id"]  # one queued check per 5 minutes
    kind = admin_rows.execute("select kind from public.jobs where id = %s", [first["job_id"]]).fetchone()[0]
    assert kind == "domains.check"


def test_failed_domains_cannot_be_rechecked(live, admin_rows):
    admin_rows.execute("update public.garage_domains set status = 'failed' where id = %s", [DOMAIN])
    try:
        with pytest.raises(db.PlatformError) as error:
            db.call_platform_function(
                "platform_request_domains_check", [str(DOMAIN), "Integration re-check"], actor_id=ADMIN
            )
        assert error.value.code == "DOMAIN_NOT_CHECKABLE"
    finally:
        admin_rows.execute("update public.garage_domains set status = 'verifying' where id = %s", [DOMAIN])


def test_status_payload_from_real_data(live, settings):
    from apps.autofix import status

    body = status.payload()
    assert body["product"] == "autofix" and body["tenants"]["total"] >= 1
