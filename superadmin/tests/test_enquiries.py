"""Enquiries: the contact page's messages. SuperAdmin and Support read and handle them; Finance never
sees them. Opening one is audited; status and notes go through ``platform_update_enquiry``."""

from datetime import timedelta
from unittest import mock

import pytest
from django.urls import reverse
from django_otp.oath import TOTP
from django_otp.plugins.otp_totp.models import TOTPDevice

from apps.accounts.roles import SUPPORT
from apps.audit.models import AuditEvent
from apps.autofix import db
from apps.autofix.models import PlatformAuditEntry, PlatformEnquiry
from apps.autofix.services import clean_notes

from .conftest import ADMIN_ID, HX

SUPPORT_ADMIN_ID = "5a000000-0000-4000-8000-0000000000b2"


@pytest.fixture
def platform():
    with mock.patch.object(db, "call_platform_function") as call:
        call.return_value = {"ok": True}
        yield call


@pytest.fixture
def linked_support(make_user):
    return make_user(SUPPORT, email="linked-support@example.test", autofix_admin_id=SUPPORT_ADMIN_ID)


@pytest.fixture
def enquiries(af):
    now = af.now
    return {
        "new": af.make(PlatformEnquiry, name="Priya Shah", received_at=now - timedelta(hours=1)),
        "older": af.make(
            PlatformEnquiry,
            name="Tom Reid",
            email="tom@example.test",
            phone=None,
            garage_name=None,
            topic="support",
            message="My booking page shows the wrong hours.",
            status="in_progress",
            handled_by_name="Vitalos Admin",
            notes="Called back on Monday.",
            received_at=now - timedelta(days=2),
        ),
        "closed": af.make(
            PlatformEnquiry,
            name="Ana Lopez",
            email="ana@example.test",
            topic="partnership",
            status="closed",
            received_at=now - timedelta(days=5),
        ),
    }


def update(client, enquiry, **data):
    return client.post(reverse("autofix:enquiry_update", args=[enquiry.pk]), data)


# --- Who sees them -------------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["superadmin", "support"])
def test_superadmin_and_support_see_the_list_newest_first(client_for, request, enquiries, who):
    body = client_for(request.getfixturevalue(who)).get(reverse("autofix:enquiries")).content.decode()
    assert body.index("Priya Shah") < body.index("Tom Reid") < body.index("Ana Lopez")
    assert 'data-testid="kpi-enquiries-new"' in body
    # The list carries who, about what and where it stands; contact details and messages are on the detail page.
    assert "priya@example.test" not in body and "07700 900123" not in body and "demo for our two" not in body


@pytest.mark.parametrize("who", ["finance", "norole"])
def test_finance_and_users_without_a_role_are_refused(client_for, request, enquiries, who):
    client = client_for(request.getfixturevalue(who))
    assert client.get(reverse("autofix:enquiries")).status_code == 403
    assert client.get(reverse("autofix:enquiry", args=[enquiries["new"].pk])).status_code == 403
    assert update(client, enquiries["new"], status="closed", notes="").status_code == 403


def test_anonymous_is_sent_to_login(client, enquiries):
    response = client.get(reverse("autofix:enquiry", args=[enquiries["new"].pk]))
    assert response.status_code == 302 and reverse("accounts:login") in response["Location"]


def test_filters_by_status_and_topic(client_for, support, enquiries):
    client = client_for(support)
    body = client.get(reverse("autofix:enquiries"), {"status": "in_progress"}).content.decode()
    assert "Tom Reid" in body and "Priya Shah" not in body and "Ana Lopez" not in body
    body = client.get(reverse("autofix:enquiries"), {"topic": "partnership"}).content.decode()
    assert "Ana Lopez" in body and "Tom Reid" not in body
    # Unknown values are dropped, not passed to the ORM.
    body = client.get(reverse("autofix:enquiries"), {"status": "spam", "topic": "x"}).content.decode()
    assert "Priya Shah" in body and "Ana Lopez" in body


def test_the_filter_partial_is_just_the_table(client_for, support, enquiries):
    response = client_for(support).get(
        reverse("autofix:enquiries"), {"status": "new"}, HTTP_HX_TARGET="enquiry-results", **HX
    )
    body = response.content.decode()
    assert response.status_code == 200 and "<html" not in body and "Priya Shah" in body


def test_detail_shows_the_sender_and_is_audited(client_for, support, enquiries):
    enquiry = enquiries["new"]
    response = client_for(support).get(reverse("autofix:enquiry", args=[enquiry.pk]))
    body = response.content.decode()
    assert response.status_code == 200
    assert "no-store" in response["Cache-Control"]
    assert 'href="mailto:priya@example.test"' in body and 'href="tel:07700900123"' in body
    assert "We would like a demo for our two sites." in body and "Shah Motors" in body
    event = AuditEvent.objects.get(action="autofix.enquiry_viewed")
    assert event.entity_type == "autofix.platform_enquiry" and event.entity_id == str(enquiry.pk)
    # Our trail names the enquiry by id and topic, never by the sender's details.
    assert (
        "Priya" not in event.summary and "priya@" not in event.summary and "Sales or a demo" in event.summary
    )


def test_detail_escapes_what_the_sender_typed(client_for, support, af):
    enquiry = af.make(
        PlatformEnquiry, name="<script>x</script>", message="<img src=x onerror=alert(1)> hello there"
    )
    body = client_for(support).get(reverse("autofix:enquiry", args=[enquiry.pk])).content.decode()
    assert "<script>x</script>" not in body and "<img src=x" not in body
    assert "&lt;img src=x onerror=alert(1)&gt;" in body


def test_unknown_and_malformed_enquiries_are_404(client_for, support, enquiries):
    client = client_for(support)
    assert (
        client.get(reverse("autofix:enquiry", args=["00000000-0000-4000-8000-000000000000"])).status_code
        == 404
    )
    assert client.get("/enquiries/not-a-uuid/").status_code == 404


def test_detail_shows_the_history_from_autofix(client_for, superadmin, af, enquiries):
    enquiry = enquiries["older"]
    af.make(
        PlatformAuditEntry,
        action="platform.enquiry_status_changed",
        entity_type="platform_enquiry",
        entity_id=str(enquiry.pk),
        actor_name="Vitalos Admin",
        detail={"from": "new", "to": "in_progress"},
    )
    af.make(
        PlatformAuditEntry,
        action="platform.enquiry_notes_changed",
        entity_type="platform_enquiry",
        entity_id=str(enquiry.pk),
        actor_name="Vitalos Admin",
        detail={"length": 22},
    )
    body = client_for(superadmin).get(reverse("autofix:enquiry", args=[enquiry.pk])).content.decode()
    assert "Status: New → In progress" in body and "Notes changed (22 characters)" in body


# --- Changes -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("who", "admin_id"), [("superadmin", ADMIN_ID), ("linked_support", SUPPORT_ADMIN_ID)]
)
def test_superadmin_and_support_change_the_status_through_autofix(
    client_for, request, enquiries, platform, who, admin_id
):
    enquiry = enquiries["new"]
    response = update(client_for(request.getfixturevalue(who)), enquiry, status="in_progress", notes="")
    assert response.status_code == 302 and response["Location"] == reverse(
        "autofix:enquiry", args=[enquiry.pk]
    )
    platform.assert_called_once_with(
        "platform_update_enquiry", [str(enquiry.pk), "in_progress", None], actor_id=mock.ANY
    )
    assert str(platform.call_args.kwargs["actor_id"]) == admin_id
    event = AuditEvent.objects.get(action="autofix.enquiry_updated")
    assert event.metadata["status"] == "in_progress" and event.metadata["notes_changed"] is False
    assert "status New → In progress" in event.summary


def test_notes_change_alone_sends_only_the_notes_and_never_logs_them(
    client_for, superadmin, enquiries, platform
):
    enquiry = enquiries["older"]
    update(client_for(superadmin), enquiry, status="in_progress", notes="  Demo booked for Friday.\r\n  ")
    platform.assert_called_once_with(
        "platform_update_enquiry", [str(enquiry.pk), None, "Demo booked for Friday."], actor_id=mock.ANY
    )
    event = AuditEvent.objects.get(action="autofix.enquiry_updated")
    assert event.metadata["notes_changed"] is True and event.metadata["notes_length"] == 23
    assert "Demo booked" not in str(event.metadata) and "Demo booked" not in event.summary


def test_empty_notes_clear_them(client_for, superadmin, enquiries, platform):
    enquiry = enquiries["older"]
    update(client_for(superadmin), enquiry, status="closed", notes="   ")
    platform.assert_called_once_with(
        "platform_update_enquiry", [str(enquiry.pk), "closed", ""], actor_id=mock.ANY
    )
    assert "notes cleared" in AuditEvent.objects.get(action="autofix.enquiry_updated").summary


def test_nothing_to_change_makes_no_call(client_for, superadmin, enquiries, platform):
    enquiry = enquiries["older"]
    response = update(client_for(superadmin), enquiry, status="in_progress", notes="Called back on Monday.")
    assert (
        response.status_code == 200 and "Change the status or the notes first." in response.content.decode()
    )
    platform.assert_not_called()


@pytest.mark.parametrize("data", [{"status": "spam", "notes": ""}, {"status": "closed", "notes": "x" * 5001}])
def test_invalid_input_makes_no_call(client_for, superadmin, enquiries, platform, data):
    response = update(client_for(superadmin), enquiries["new"], **data)
    assert response.status_code == 200
    platform.assert_not_called()


def test_unlinked_users_cannot_change_enquiries(
    client_for, support, unlinked_superadmin, enquiries, platform
):
    for user in (support, unlinked_superadmin):
        client = client_for(user)
        page = client.get(reverse("autofix:enquiry", args=[enquiries["new"].pk])).content.decode()
        assert "not linked to a Pitline platform admin" in page and 'data-testid="enquiry-form"' not in page
        response = update(client, enquiries["new"], status="closed", notes="")
        assert (
            response.status_code == 200
            and "not linked to a Pitline platform admin" in response.content.decode()
        )
    platform.assert_not_called()


def test_unverified_session_is_sent_to_the_second_factor(client_for, superadmin, enquiries, platform):
    response = update(client_for(superadmin, verified=False), enquiries["new"], status="closed", notes="")
    assert response.status_code == 302 and "/account/2fa/" in response["Location"]
    platform.assert_not_called()


def test_refusal_from_autofix_is_shown_and_audited(client_for, superadmin, enquiries, platform):
    platform.side_effect = db.PlatformError("ENQUIRY_NOT_FOUND")
    response = update(client_for(superadmin), enquiries["new"], status="closed", notes="")
    assert response.status_code == 200 and "That enquiry could not be found." in response.content.decode()
    assert AuditEvent.objects.filter(action="autofix.enquiry_update_refused").count() == 1
    assert not AuditEvent.objects.filter(action="autofix.enquiry_updated").exists()


def test_a_fresh_authenticator_code_is_needed_with_step_up_on(
    client_for, superadmin, enquiries, platform, settings
):
    settings.AUTOFIX_STEP_UP = True
    client = client_for(superadmin)
    response = update(client, enquiries["new"], status="closed", notes="")
    assert response.status_code == 200 and "Authenticator code" in response.content.decode()
    platform.assert_not_called()
    device = TOTPDevice.objects.get(user=superadmin, confirmed=True)
    code = f"{TOTP(device.bin_key, device.step, device.t0, device.digits, device.drift).token():06d}"
    assert update(client, enquiries["new"], status="closed", notes="", step_up_code=code).status_code == 302
    platform.assert_called_once()


def test_clean_notes():
    assert clean_notes("  a\r\nb\rc\x07  ") == "a\nb\nc"
    assert clean_notes(None) == ""


# --- Navigation, palette and help ----------------------------------------------------------------


@pytest.mark.parametrize(("who", "visible"), [("superadmin", True), ("support", True), ("finance", False)])
def test_enquiries_are_in_the_navigation_for_those_who_handle_them(client_for, request, seeded, who, visible):
    body = client_for(request.getfixturevalue(who)).get(reverse("core:overview")).content.decode()
    assert (f'href="{reverse("autofix:enquiries")}"' in body) is visible


def test_palette_lists_the_page_and_finds_enquiries_by_name(client_for, support, enquiries):
    client = client_for(support)
    pages = client.get(reverse("core:palette"), {"q": "enquir"}).content.decode()
    assert reverse("autofix:enquiries") in pages
    found = client.get(reverse("core:palette"), {"q": "Tom R"}).content.decode()
    assert "Tom Reid" in found and reverse("autofix:enquiry", args=[enquiries["older"].pk]) in found
    assert "tom@example.test" not in found
    # Never by email address.
    assert "Tom Reid" not in client.get(reverse("core:palette"), {"q": "tom@example"}).content.decode()


def test_palette_never_shows_enquiries_to_finance(client_for, finance, enquiries):
    body = client_for(finance).get(reverse("core:palette"), {"q": "Tom R"}).content.decode()
    assert "Tom Reid" not in body and reverse("autofix:enquiries") not in body


def test_help_explains_enquiries(client_for, support):
    body = client_for(support).get(reverse("core:help")).content.decode()
    assert 'id="enquiries-help"' in body and reverse("autofix:enquiries") in body
