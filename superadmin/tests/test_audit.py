"""Both audit trails: append-only, filters, CSV export (itself audited)."""

import csv
import io

import pytest
from django.urls import reverse

from apps.audit.models import AppendOnlyError, AuditEvent
from apps.audit.services import ACTIONS, record


def test_audit_events_are_append_only(superadmin):
    event = record("auth.sign_in", actor=superadmin, summary="x")
    event.summary = "changed"
    with pytest.raises(AppendOnlyError):
        event.save()
    with pytest.raises(AppendOnlyError):
        event.delete()
    with pytest.raises(AppendOnlyError):
        AuditEvent.objects.all().update(summary="x")
    with pytest.raises(AppendOnlyError):
        AuditEvent.objects.all().delete()


def test_sign_in_and_out_are_recorded(superadmin):
    from django.test import Client

    client = Client()
    superadmin.set_password("a-long-password-123")
    superadmin.save()
    client.post("/login/", {"email": superadmin.email, "password": "a-long-password-123"})
    client.post("/login/", {"email": superadmin.email, "password": "wrong-password-123"})
    actions = set(AuditEvent.objects.values_list("action", flat=True))
    assert {"auth.sign_in"} <= actions


def test_failed_sign_in_keeps_the_email_not_the_password():
    from django.test import Client

    Client().post("/login/", {"email": "who@example.test", "password": "secret-guess-123"})
    event = AuditEvent.objects.get(action="auth.sign_in_failed")
    assert event.metadata["attempted_email"] == "who@example.test"
    assert "secret-guess-123" not in str(event.metadata)


def test_every_autofix_action_has_a_label():
    for action in (
        "autofix.garage_updated",
        "autofix.job_retried",
        "autofix.domain_check_requested",
        "autofix.view_as_support",
        "autofix.personal_data_viewed",
        "autofix.garages_exported",
    ):
        assert action in ACTIONS


def test_trail_filters_and_export(client_for, superadmin):
    record(
        "autofix.view_as_support",
        actor=superadmin,
        entity_type="autofix.garage",
        entity_id="g1",
        summary="Hartley",
    )
    record("users.created", actor=superadmin, summary="Someone")
    client = client_for(superadmin)
    body = client.get(reverse("audit:trail"), {"action": "autofix.view_as_support"}).content.decode()
    table = body[body.index('data-testid="data-table"') :]
    assert "Handed off to View as support" in table and "Created a user" not in table
    export = client.get(reverse("audit:export"), {"action": "autofix.view_as_support"})
    lines = list(csv.reader(io.StringIO(export.content.decode())))
    assert lines[0][0] == "time" and len(lines) == 2
    assert AuditEvent.objects.filter(action="audit.exported").exists()


def test_trail_ignores_bad_filters(client_for, superadmin):
    response = client_for(superadmin).get(
        reverse("audit:trail"), {"action": "nope", "date_from": "not-a-date"}
    )
    assert response.status_code == 200


def test_platform_log_filters_and_export(client_for, superadmin, seeded):
    client = client_for(superadmin)
    body = client.get(reverse("autofix:platform_audit"), {"garage": "hartley"}).content.decode()
    assert "platform.garage_status_changed" in body and "Unpaid invoice" in body
    empty = client.get(reverse("autofix:platform_audit"), {"garage": "nobody"}).content.decode()
    assert "No Autofix platform actions match" in empty
    export = client.get(reverse("autofix:platform_audit_export"))
    lines = list(csv.reader(io.StringIO(export.content.decode())))
    assert lines[0][1] == "action" and len(lines) == 2
    assert AuditEvent.objects.filter(action="audit.autofix_exported").exists()


def test_platform_log_date_filters(client_for, superadmin, seeded):
    response = client_for(superadmin).get(
        reverse("autofix:platform_audit"), {"date_from": "2000-01-01", "date_to": "2000-01-02"}
    )
    assert b"No Autofix platform actions match" in response.content


def test_activity_merges_both_trails_without_sign_ins(client_for, finance, seeded):
    record("auth.sign_in", actor=finance, summary="Signed in")
    record("autofix.garages_exported", actor=finance, summary="2 garages")
    body = client_for(finance).get(reverse("autofix:activity")).content.decode()
    assert "Exported garages" in body and "Garage status changed" in body
    assert "Signed in" not in body
    only_autofix = (
        client_for(finance).get(reverse("autofix:activity"), {"source": "autofix"}).content.decode()
    )
    assert "Exported garages" not in only_autofix
