"""Step-up: with AUTOFIX_STEP_UP on, each sensitive action needs a fresh authenticator code."""

from unittest import mock

import pytest
from django.urls import reverse
from django_otp.oath import TOTP
from django_otp.plugins.otp_totp.models import TOTPDevice

from apps.accounts.models import ApiToken
from apps.audit.models import AuditEvent
from apps.autofix import db

from .conftest import HX

REASON = "Customer asked to move plans"


@pytest.fixture(autouse=True)
def step_up_on(settings):
    settings.AUTOFIX_STEP_UP = True


@pytest.fixture
def platform():
    with mock.patch.object(db, "call_platform_function") as call:
        call.return_value = {"ok": True}
        yield call


def code_for(user) -> str:
    device = TOTPDevice.objects.get(user=user, confirmed=True)
    return f"{TOTP(device.bin_key, device.step, device.t0, device.digits, device.drift).token():06d}"


def plan_post(client, garage, **extra):
    data = {"plan": "essentials", "status": garage.status, "reason": REASON, **extra}
    return client.post(reverse("autofix:garage_plan", args=[garage.pk]), data, **HX)


def test_plan_change_without_a_code_is_refused_before_autofix_is_called(
    client_for, superadmin, seeded, platform
):
    response = plan_post(client_for(superadmin), seeded["demo"])
    assert response.status_code == 200 and "Authenticator code" in response.content.decode()
    platform.assert_not_called()


def test_plan_change_with_a_fresh_code_goes_through(client_for, superadmin, seeded, platform):
    client = client_for(superadmin)
    response = plan_post(client, seeded["demo"], step_up_code=code_for(superadmin))
    assert response.status_code == 204
    platform.assert_called_once()
    assert "step_up_code" not in str(AuditEvent.objects.get(action="autofix.garage_updated").metadata)


def test_a_code_works_once(client_for, superadmin, seeded, platform):
    client = client_for(superadmin)
    code = code_for(superadmin)
    assert plan_post(client, seeded["demo"], step_up_code=code).status_code == 204
    again = plan_post(client, seeded["hartley"], step_up_code=code)
    assert again.status_code == 200 and "not accepted" in again.content.decode()
    assert platform.call_count == 1


def test_a_wrong_reason_does_not_use_up_the_code(client_for, superadmin, seeded, platform):
    client = client_for(superadmin)
    code = code_for(superadmin)
    assert plan_post(client, seeded["demo"], reason="no", step_up_code=code).status_code == 200
    assert plan_post(client, seeded["demo"], step_up_code=code).status_code == 204


def test_job_retry_needs_a_code(client_for, superadmin, seeded, platform):
    job = seeded["failed_job"]
    client = client_for(superadmin)
    response = client.post(reverse("autofix:job_retry", args=[job.pk]), {"reason": REASON}, follow=True)
    assert "authenticator code" in response.content.decode().lower()
    platform.assert_not_called()
    assert 'name="step_up_code"' in client.get(reverse("autofix:jobs")).content.decode()


def test_domain_recheck_needs_a_code(client_for, superadmin, seeded, platform):
    domain = seeded["pending_domain"]
    client = client_for(superadmin)
    client.post(reverse("autofix:domain_recheck", args=[domain.pk]), {"reason": REASON})
    platform.assert_not_called()
    client.post(
        reverse("autofix:domain_recheck", args=[domain.pk]),
        {"reason": REASON, "step_up_code": code_for(superadmin)},
    )
    platform.assert_called_once()


def test_customer_details_need_a_code(client_for, support, seeded):
    garage = seeded["hartley"]
    client = client_for(support)
    url = reverse("autofix:booking_people", args=[garage.pk])
    refused = client.post(url, **HX)
    assert "Olivia" not in refused.content.decode() and "not accepted" in refused.content.decode()
    assert not AuditEvent.objects.filter(action="autofix.personal_data_viewed").exists()
    shown = client.post(url, {"step_up_code": code_for(support)}, **HX)
    assert "Olivia Bennett" in shown.content.decode()


def test_view_as_support_needs_a_code(client_for, support, seeded):
    garage = seeded["hartley"]
    client = client_for(support)
    url = reverse("autofix:view_as_support", args=[garage.pk])
    assert client.post(url, {"reason": REASON}).status_code == 200
    assert not AuditEvent.objects.filter(action="autofix.view_as_support").exists()
    response = client.post(url, {"reason": REASON, "step_up_code": code_for(support)})
    assert response.status_code == 302


def test_api_token_needs_a_code(client_for, superadmin):
    client = client_for(superadmin)
    url = reverse("accounts:settings_tokens")
    client.post(url, {"name": "Power BI", "expires_in_days": 30})
    assert not ApiToken.objects.exists()
    client.post(url, {"name": "Power BI", "expires_in_days": 30, "step_up_code": code_for(superadmin)})
    assert ApiToken.objects.count() == 1


def test_user_changes_need_a_code(client_for, superadmin, support):
    client = client_for(superadmin)
    url = reverse("accounts:user_edit", args=[support.pk])
    data = {"full_name": "Renamed", "role": "Support", "autofix_admin": "", "is_active": "on"}
    client.post(url, data, **HX)
    support.refresh_from_db()
    assert support.full_name != "Renamed"
    client.post(url, {**data, "step_up_code": code_for(superadmin)}, **HX)
    support.refresh_from_db()
    assert support.full_name == "Renamed"


def test_step_up_is_off_unless_configured(client_for, superadmin, seeded, platform, settings):
    settings.AUTOFIX_STEP_UP = False
    assert plan_post(client_for(superadmin), seeded["demo"]).status_code == 204
