"""Pitline alerts in the bell: the scan command, dedupe, preferences and the badge."""

import io

from django.core.management import call_command
from django.urls import reverse

from apps.notifications.models import Notification, NotificationPreference
from apps.notifications.services import notify

ALERTS = Notification.objects.exclude(kind="role_assigned")


def scan():
    out = io.StringIO()
    call_command("notify_attention", stdout=out)
    return out.getvalue()


def test_scan_notifies_superadmin_and_support_once(superadmin, support, finance, seeded):
    scan()
    first = ALERTS.count()
    assert first > 0
    assert not ALERTS.filter(recipient=finance).exists()
    assert Notification.objects.filter(recipient=support, kind="job_failed").exists()
    scan()
    assert ALERTS.count() == first


def test_preferences_turn_kinds_off(superadmin, seeded):
    NotificationPreference.objects.create(user=superadmin, job_failures=False)
    scan()
    assert not Notification.objects.filter(recipient=superadmin, kind="job_failed").exists()
    assert Notification.objects.filter(recipient=superadmin, kind="domain_failed").exists()


def test_scan_survives_autofix_being_down(superadmin, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    err = io.StringIO()
    call_command("notify_attention", stdout=io.StringIO(), stderr=err)
    assert "unavailable" in err.getvalue() and not ALERTS.exists()


def test_inactive_users_are_skipped(make_user):
    user = make_user(None, is_active=False)
    assert notify([user], Notification.Kind.JOB_FAILED, "x") == 0


def test_badge_and_open_and_read_all(client_for, superadmin):
    Notification.objects.all().delete()
    notify([superadmin], Notification.Kind.JOB_FAILED, "A job failed", url="/jobs/")
    client = client_for(superadmin)
    assert b"1 unread" in client.get(reverse("notifications:badge")).content
    note = Notification.objects.get()
    opened = client.post(reverse("notifications:open", args=[note.pk]))
    assert opened["Location"] == "/jobs/"
    notify([superadmin], Notification.Kind.JOB_FAILED, "Another", url="https://evil.example/")
    evil = Notification.objects.get(title="Another")
    assert client.post(reverse("notifications:open", args=[evil.pk]))["Location"] == "/notifications/"
    client.post(reverse("notifications:read_all"))
    assert not Notification.objects.filter(read_at__isnull=True).exists()


def test_preferences_page_saves(client_for, finance):
    client = client_for(finance)
    response = client.post(reverse("notifications:preferences"), {"domain_failures": "on"})
    assert response.status_code == 302
    pref = NotificationPreference.objects.get(user=finance)
    assert pref.domain_failures and not pref.job_failures


def test_attention_tab_for_support_only(client_for, support, finance, seeded):
    assert (
        b"Needs attention in Pitline" in client_for(support).get(reverse("notifications:attention")).content
    )
    assert client_for(finance).get(reverse("notifications:attention")).status_code == 403
