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
CALL = uuid.UUID("5a000000-0000-4000-8000-00000000a1f5")
PLATFORM_CALL = uuid.UUID("5a000000-0000-4000-8000-00000000a1f6")
RECORDING = f"https://api.twilio.com/2010-04-01/Accounts/AC{'5' * 32}/Recordings/RE{'5' * 32}"
ENQUIRY = uuid.UUID("5a000000-0000-4000-8000-00000000a1f7")


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
            # plan and trial_ends_at take their defaults: a new garage starts on the Pro trial (D17).
            "insert into public.garages (id, slug, name, booking_prefix, status) values "
            "(%s, 'sa-integration', 'SA Integration Garage', 'SAI', 'active')",
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
        conn.execute(
            "insert into public.calls (id, garage_id, provider_call_sid, from_number, to_number, status, missed, "
            "voicemail_url, voicemail_duration_s) values "
            "(%s, %s, 'CA-sa-integration', '+447700900123', '+441146974393', 'completed', true, %s, 42)",
            [CALL, GARAGE, RECORDING],
        )
        conn.execute(
            "insert into public.platform_calls (id, provider_call_sid, from_number, to_number, status, "
            "voicemail_url, voicemail_duration_s) values "
            "(%s, 'CA-sa-integration-platform', '+447700900777', '+441146974393', 'completed', %s, 31)",
            [PLATFORM_CALL, RECORDING.replace("RE" + "5" * 32, "RE" + "6" * 32)],
        )
        conn.execute(
            "insert into public.platform_enquiries (id, name, email, phone, garage_name, topic, message) values "
            "(%s, 'SA Integration Sender', 'sender@sa-integration.example', '07700 900555', 'SA Motors', 'sales', "
            "'Integration test enquiry about a demo.')",
            [ENQUIRY],
        )
        yield conn
        conn.execute("delete from public.platform_enquiries where id = %s", [ENQUIRY])
        conn.execute("delete from public.platform_calls where id = %s", [PLATFORM_CALL])
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
        "call_voicemails",
        "garage_agreements",
        "platform_audit_log",
        "platform_impersonations",
        "platform_enquiries",
    ],
)
def test_role_reads_every_view(admin_rows, view):
    with role() as conn:
        conn.execute(f"select * from superadmin.{view} limit 1")  # noqa: S608


@pytest.mark.parametrize(
    "table",
    ["garages", "customers", "bookings", "messages", "jobs", "platform_audit_log", "platform_enquiries"],
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
        conn.execute(
            "select public.platform_update_garage(%s, 'essentials', null, 'read only test')", [GARAGE]
        )


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


def test_calls_arrive_masked_and_links_only_in_call_voicemails(admin_rows):
    with role() as conn:
        cols = {
            row[0]
            for row in conn.execute(
                "select column_name from information_schema.columns where table_schema = 'superadmin' and table_name = 'calls'"
            )
        }
        assert not {"from_number", "to_number", "voicemail_url", "provider_call_sid"} & cols
        row = conn.execute(
            "select caller_masked, has_voicemail, voicemail_duration_s from superadmin.calls where id = %s",
            [CALL],
        ).fetchone()
        assert row == ("07••• •••123", True, 42)


def test_call_selectors_read_through_the_role(live):
    rows = list(selectors.calls({"garage": str(GARAGE)}))
    assert [(row.caller_masked, row.has_voicemail) for row in rows] == [("07••• •••123", True)]
    call, link = selectors.voicemail(CALL)
    assert call.garage.name == "SA Integration Garage" and link == RECORDING
    platform = [row for row in selectors.calls({"garage": "platform"}) if row.pk == PLATFORM_CALL]
    assert [(row.caller_masked, row.garage_id, row.line_name) for row in platform] == [
        ("07••• •••777", None, "Pitline (platform line)")
    ]
    assert selectors.voicemail(PLATFORM_CALL)[1].endswith("RE" + "6" * 32)


def test_role_cannot_read_platform_calls_directly(admin_rows):
    with role() as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("select 1 from public.platform_calls limit 1")


def test_selectors_read_through_the_role(live):
    counts = selectors.garage_counts()
    assert counts["total"] >= 1
    assert selectors.garage(GARAGE).name == "SA Integration Garage"
    assert any(item.key == f"job:{JOB}" for item in selectors.attention_items(limit=50))


def test_plan_change_goes_through_platform_update_garage(live, admin_rows):
    garage = selectors.garage(GARAGE)
    assert garage.plan == "pro" and garage.plan_key == "trial" and garage.trial_ends_at is not None
    result = db.call_platform_function(
        "platform_update_garage",
        [str(GARAGE), "essentials", None, "Integration test plan change"],
        actor_id=ADMIN,
    )
    assert result["plan"] == "essentials" and result["trial_ends_at"] is None
    garage = selectors.garage(GARAGE)
    assert garage.plan_chosen == "essentials" and garage.plan_label == "Essentials"
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
            "platform_update_garage", [str(GARAGE), "pro", None, "Should be refused"], actor_id=uuid.uuid4()
        )
    assert error.value.code == "PLATFORM_ADMIN_REQUIRED"


def test_short_reason_is_refused_by_the_database(live):
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function("platform_update_garage", [str(GARAGE), "pro", None, "no"], actor_id=ADMIN)
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


def test_garages_view_reads_the_d17_trial_and_chosen_plan(admin_rows):
    """The view reads trial_ends_at and plan_chosen (20261029000100_plans.sql) from the row as JSON."""
    admin_rows.execute(
        "update public.garages set trial_ends_at = '2030-01-01T00:00:00Z', plan_chosen = 'pro' where id = %s",
        [GARAGE],
    )
    with role() as conn:
        ends, chosen = conn.execute(
            "select trial_ends_at, plan_chosen from superadmin.garages where id = %s", [GARAGE]
        ).fetchone()
    assert ends.year == 2030 and chosen == "pro"


def test_enquiries_view_has_the_sender_but_no_ip_hash(admin_rows):
    with role() as conn:
        cols = {
            row[0]
            for row in conn.execute(
                "select column_name from information_schema.columns where table_schema = 'superadmin' and table_name = 'platform_enquiries'"
            )
        }
        assert {"name", "email", "phone", "message", "status", "notes", "handled_by_name"} <= cols
        assert "ip_hash" not in cols


def test_enquiry_change_goes_through_platform_update_enquiry(live, admin_rows):
    enquiry = selectors.enquiry(ENQUIRY)
    assert enquiry.status == "new" and enquiry.email == "sender@sa-integration.example"
    result = db.call_platform_function(
        "platform_update_enquiry",
        [str(ENQUIRY), "in_progress", "Called back about the demo."],
        actor_id=ADMIN,
    )
    assert result["status"] == "in_progress" and result["notes"] == "Called back about the demo."
    enquiry = selectors.enquiry(ENQUIRY)
    assert enquiry.status == "in_progress" and enquiry.handled_by == ADMIN
    actions = [
        row[0]
        for row in admin_rows.execute(
            "select action from public.platform_audit_log where entity_type = 'platform_enquiry' and entity_id = %s order by id",
            [str(ENQUIRY)],
        )
    ]
    assert actions == ["platform.enquiry_status_changed", "platform.enquiry_notes_changed"]
    assert [entry.action for entry in selectors.enquiry_history(ENQUIRY)] == list(reversed(actions))


def test_enquiry_changes_are_refused_for_a_non_admin_and_for_nothing_to_change(live, admin_rows):
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function(
            "platform_update_enquiry", [str(ENQUIRY), "closed", None], actor_id=uuid.uuid4()
        )
    assert error.value.code == "PLATFORM_ADMIN_REQUIRED"
    with pytest.raises(db.PlatformError) as error:
        db.call_platform_function("platform_update_enquiry", [str(ENQUIRY), None, None], actor_id=ADMIN)
    assert error.value.code == "NOTHING_TO_CHANGE"


def test_role_cannot_write_enquiries_directly(admin_rows):
    with role() as conn:
        writable = conn.execute(
            "select has_table_privilege('superadmin.platform_enquiries', 'insert,update,delete')"
        ).fetchone()[0]
        assert writable is False
        conn.autocommit = False
        conn.execute("set transaction read write")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update public.platform_enquiries set status = 'closed'")
        conn.rollback()
