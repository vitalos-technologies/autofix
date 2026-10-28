"""Changes to Autofix: role, second factor, link and reason checks, the platform call, and our audit."""

from unittest import mock
from urllib.parse import urlsplit

import pytest
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.autofix import db

from .conftest import ADMIN_ID, HX

REASON = "Customer asked to move to Growth"


@pytest.fixture
def platform():
    with mock.patch.object(db, "call_platform_function") as call:
        call.return_value = {"ok": True}
        yield call


# --- Plan and status -----------------------------------------------------------------------------


def test_superadmin_changes_plan_through_the_platform_function(client_for, superadmin, seeded, platform):
    garage = seeded["demo"]
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": garage.status, "reason": REASON},
        **HX,
    )
    assert response.status_code == 204 and "vsa-close-modal" in response["HX-Trigger"]
    platform.assert_called_once_with(
        "platform_update_garage", [str(garage.pk), "essentials", None, REASON], actor_id=mock.ANY
    )
    assert str(platform.call_args.kwargs["actor_id"]) == ADMIN_ID
    event = AuditEvent.objects.get(action="autofix.garage_updated")
    assert event.entity_id == str(garage.pk) and event.metadata["reason"] == REASON
    assert "Pro (trial) → Essentials" in event.summary


def test_status_change_sends_only_what_changed(client_for, superadmin, seeded, platform):
    garage = seeded["hartley"]
    client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "suspended", "reason": "Unpaid for two months"},
        **HX,
    )
    assert platform.call_args.args[1] == [str(garage.pk), None, "suspended", "Unpaid for two months"]


def test_no_change_is_refused_without_a_call(client_for, superadmin, seeded, platform):
    garage = seeded["hartley"]
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": garage.status, "reason": REASON},
        **HX,
    )
    assert response.status_code == 200 and b"Choose a different plan or status" in response.content
    platform.assert_not_called()


@pytest.mark.parametrize("reason", ["", "abc", "x" * 501])
def test_reason_is_required(client_for, superadmin, seeded, platform, reason):
    garage = seeded["demo"]
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "active", "reason": reason},
        **HX,
    )
    assert response.status_code == 200
    platform.assert_not_called()


def test_unlinked_superadmin_cannot_change_autofix(client_for, unlinked_superadmin, seeded, platform):
    garage = seeded["demo"]
    response = client_for(unlinked_superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "active", "reason": REASON},
        **HX,
    )
    assert response.status_code == 200 and b"not linked to an Autofix platform admin" in response.content
    platform.assert_not_called()


def test_unverified_session_is_sent_to_the_second_factor(client_for, superadmin, seeded, platform):
    garage = seeded["demo"]
    response = client_for(superadmin, verified=False).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "active", "reason": REASON},
    )
    assert response.status_code == 302 and "/account/2fa/" in response["Location"]
    platform.assert_not_called()


@pytest.mark.parametrize("who", ["support", "finance"])
def test_only_superadmin_changes_plans(client_for, request, seeded, platform, who):
    user = request.getfixturevalue(who)
    garage = seeded["demo"]
    response = client_for(user).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "active", "reason": REASON},
    )
    assert response.status_code == 403
    platform.assert_not_called()


def test_refusal_from_autofix_is_shown_and_audited(client_for, superadmin, seeded, platform):
    platform.side_effect = db.PlatformError("PLATFORM_ADMIN_REQUIRED")
    garage = seeded["demo"]
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": "active", "reason": REASON},
        **HX,
    )
    assert response.status_code == 200 and b"did not accept your linked platform admin" in response.content
    assert AuditEvent.objects.filter(action="autofix.garage_update_refused").count() == 1
    assert not AuditEvent.objects.filter(action="autofix.garage_updated").exists()


# --- Job retry -----------------------------------------------------------------------------------


def test_superadmin_retries_a_failed_job(client_for, superadmin, seeded, platform):
    platform.return_value = True
    job = seeded["failed_job"]
    response = client_for(superadmin).post(
        reverse("autofix:job_retry", args=[job.pk]), {"reason": "Twilio is back up"}
    )
    assert response.status_code == 302
    platform.assert_called_once_with(
        "platform_retry_job", [str(job.pk), "Twilio is back up"], actor_id=mock.ANY
    )
    assert AuditEvent.objects.filter(action="autofix.job_retried", entity_id=str(job.pk)).exists()


def test_retry_needs_a_reason(client_for, superadmin, seeded, platform):
    job = seeded["failed_job"]
    client_for(superadmin).post(reverse("autofix:job_retry", args=[job.pk]), {"reason": "no"})
    platform.assert_not_called()


def test_retry_of_a_job_that_is_not_failed_makes_no_call(client_for, superadmin, af, platform):
    from apps.autofix.models import Job

    job = af.make(Job, status="queued")
    client_for(superadmin).post(reverse("autofix:job_retry", args=[job.pk]), {"reason": "Try again please"})
    platform.assert_not_called()


def test_support_cannot_retry(client_for, support, seeded, platform):
    job = seeded["failed_job"]
    assert (
        client_for(support)
        .post(reverse("autofix:job_retry", args=[job.pk]), {"reason": "Try again"})
        .status_code
        == 403
    )
    platform.assert_not_called()


def test_jobs_page_masks_contact_details_and_registrations(client_for, superadmin, seeded):
    body = client_for(superadmin).get(reverse("autofix:jobs")).content.decode()
    assert "[phone]" in body and "[reg]" in body and "[email]" in body
    assert "+447700900123" not in body and "AB12 CDE" not in body and "owner@example.test" not in body


# --- Domain re-check -----------------------------------------------------------------------------


def test_superadmin_requests_a_domain_check(client_for, superadmin, seeded, platform):
    domain = seeded["pending_domain"]
    response = client_for(superadmin).post(
        reverse("autofix:domain_recheck", args=[domain.pk]), {"reason": "Garage says DNS is set now"}
    )
    assert response.status_code == 302
    platform.assert_called_once_with(
        "platform_request_domains_check", [str(domain.pk), "Garage says DNS is set now"], actor_id=mock.ANY
    )
    assert AuditEvent.objects.filter(action="autofix.domain_check_requested").exists()


def test_failed_domains_are_not_rechecked_from_here(client_for, superadmin, seeded, platform):
    domain = seeded["failed_domain"]
    client_for(superadmin).post(
        reverse("autofix:domain_recheck", args=[domain.pk]), {"reason": "Please re-check it"}
    )
    platform.assert_not_called()


@pytest.mark.parametrize(
    "target", ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]
)
def test_recheck_redirect_stays_on_this_site(client_for, superadmin, seeded, platform, target):
    domain = seeded["pending_domain"]
    response = client_for(superadmin).post(
        reverse("autofix:domain_recheck", args=[domain.pk]),
        {"reason": "Garage says DNS is set", "next": target},
    )
    assert response["Location"] == reverse("autofix:domains")


def test_recheck_returns_to_the_garage_tab(client_for, superadmin, seeded, platform):
    domain = seeded["pending_domain"]
    back = reverse("autofix:garage", args=[domain.garage_id]) + "?tab=domains"
    response = client_for(superadmin).post(
        reverse("autofix:domain_recheck", args=[domain.pk]),
        {"reason": "Garage says DNS is set", "next": back},
    )
    assert response["Location"] == back


# --- View as support -----------------------------------------------------------------------------


def test_view_as_support_is_an_audited_post_redirect_without_credentials(
    client_for, support, seeded, settings
):
    garage = seeded["hartley"]
    client = client_for(support)
    form = client.get(reverse("autofix:view_as_support", args=[garage.pk]))
    assert form.status_code == 200
    response = client.post(
        reverse("autofix:view_as_support", args=[garage.pk]), {"reason": "Owner cannot see bookings"}
    )
    assert response.status_code == 302
    location = urlsplit(response["Location"])
    assert f"{location.scheme}://{location.netloc}" == settings.AUTOFIX_APP_URL
    assert location.path == f"/admin/garages/{garage.pk}"
    assert location.query == "" and location.fragment == ""
    event = AuditEvent.objects.get(action="autofix.view_as_support")
    assert event.metadata["reason"] == "Owner cannot see bookings" and event.actor == support


def test_view_as_support_needs_a_reason(client_for, support, seeded):
    garage = seeded["hartley"]
    response = client_for(support).post(reverse("autofix:view_as_support", args=[garage.pk]), {"reason": ""})
    assert response.status_code == 200
    assert not AuditEvent.objects.filter(action="autofix.view_as_support").exists()


def test_view_as_support_is_get_safe(client_for, support, seeded):
    garage = seeded["hartley"]
    client_for(support).get(reverse("autofix:view_as_support", args=[garage.pk]))
    assert not AuditEvent.objects.filter(action="autofix.view_as_support").exists()


def test_finance_cannot_view_as_support(client_for, finance, seeded):
    garage = seeded["hartley"]
    response = client_for(finance).post(
        reverse("autofix:view_as_support", args=[garage.pk]), {"reason": "Just looking"}
    )
    assert response.status_code == 403


def test_csp_lets_only_the_handoff_form_leave_for_autofix(client_for, support, seeded, settings):
    garage = seeded["hartley"]
    client = client_for(support)
    detail = client.get(reverse("autofix:garage", args=[garage.pk]))
    assert f"form-action 'self' {settings.AUTOFIX_APP_URL}" in detail["Content-Security-Policy"]
    overview = client.get(reverse("core:overview"))
    assert settings.AUTOFIX_APP_URL not in overview["Content-Security-Policy"]


# --- Personal data -------------------------------------------------------------------------------


def test_support_sees_masked_customer_details_and_the_view_is_audited(client_for, support, seeded):
    garage = seeded["hartley"]
    response = client_for(support).post(reverse("autofix:booking_people", args=[garage.pk]), **HX)
    body = response.content.decode()
    assert response.status_code == 200 and "Olivia Bennett" in body and "•••101" in body and "AB•••" in body
    assert response["Cache-Control"].startswith("no-store") or "no-store" in response["Cache-Control"]
    event = AuditEvent.objects.get(action="autofix.personal_data_viewed")
    assert event.entity_id == str(garage.pk) and "Olivia" not in event.summary


def test_bookings_tab_itself_has_no_personal_data(client_for, support, seeded):
    garage = seeded["hartley"]
    body = (
        client_for(support).get(reverse("autofix:garage_tab", args=[garage.pk, "bookings"])).content.decode()
    )
    assert "Olivia Bennett" not in body and "•••101" not in body


def test_finance_cannot_see_customer_details(client_for, finance, seeded):
    garage = seeded["hartley"]
    assert client_for(finance).post(reverse("autofix:booking_people", args=[garage.pk])).status_code == 403
    assert not AuditEvent.objects.filter(action="autofix.personal_data_viewed").exists()


def test_customer_details_are_post_only(client_for, support, seeded):
    garage = seeded["hartley"]
    assert client_for(support).get(reverse("autofix:booking_people", args=[garage.pk])).status_code == 405


# --- D17 plans (Essentials and Pro) over a database that may predate them -------------------------


def test_new_plan_name_falls_back_to_the_old_one_when_the_database_predates_d17(
    client_for, superadmin, seeded
):
    garage = seeded["hartley"]  # growth = Essentials
    calls = []

    def fake(name, args, *, actor_id):
        calls.append(list(args))
        if args[1] == "pro":
            raise db.PlatformError("INVALID_PLAN")
        return {"plan": args[1]}

    with mock.patch.object(db, "call_platform_function", side_effect=fake):
        response = client_for(superadmin).post(
            reverse("autofix:garage_plan", args=[garage.pk]),
            {"plan": "pro", "status": garage.status, "reason": REASON},
            **HX,
        )
    assert response.status_code == 204
    assert [c[1] for c in calls] == ["pro", "front_desk"]
    assert "Essentials → Pro" in AuditEvent.objects.get(action="autofix.garage_updated").summary


def test_other_refusals_are_not_retried(client_for, superadmin, seeded, platform):
    platform.side_effect = db.PlatformError("GARAGE_NOT_FOUND")
    garage = seeded["hartley"]
    client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "pro", "status": "active", "reason": REASON},
        **HX,
    )
    assert platform.call_count == 1


def test_choosing_the_plan_a_garage_already_has_under_its_old_name_changes_nothing(
    client_for, superadmin, seeded, platform
):
    garage = seeded["hartley"]  # growth
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "essentials", "status": garage.status, "reason": REASON},
        **HX,
    )
    assert b"Choose a different plan or status" in response.content
    platform.assert_not_called()


def test_old_plan_names_are_no_longer_offered(client_for, superadmin, seeded, platform):
    garage = seeded["hartley"]
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "growth", "status": "active", "reason": REASON},
        **HX,
    )
    assert response.status_code == 200
    platform.assert_not_called()


def test_choosing_pro_during_the_d17_trial_makes_it_the_chosen_plan(client_for, superadmin, af, platform):
    from datetime import timedelta

    from django.utils import timezone

    garage = af.garage(plan="pro", status="active", trial_ends_at=timezone.now() + timedelta(days=5))
    response = client_for(superadmin).post(
        reverse("autofix:garage_plan", args=[garage.pk]),
        {"plan": "pro", "status": "active", "reason": REASON},
        **HX,
    )
    assert response.status_code == 204
    platform.assert_called_once_with(
        "platform_update_garage", [str(garage.pk), "pro", None, REASON], actor_id=mock.ANY
    )
    assert "Pro (trial) → Pro" in AuditEvent.objects.get(action="autofix.garage_updated").summary
