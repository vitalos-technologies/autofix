"""GET /api/platform/v1/status: the ADR-044 product status contract, with no personal data."""

import json
from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.autofix import status
from apps.autofix.models import Garage

from .contract_adr044 import InvalidStatus, Product, parse_status

TOKEN = "t" * 40
URL = "/api/platform/v1/status"


def product(settings) -> Product:
    return Product(
        key="autofix",
        status_url=f"{settings.AUTOFIX_SUPERADMIN_URL}{URL}",
        superadmin_url=settings.AUTOFIX_SUPERADMIN_URL,
    )


@pytest.fixture
def token(settings):
    settings.AUTOFIX_STATUS_TOKEN = TOKEN
    return TOKEN


def get(client, value=None):
    headers = {"HTTP_AUTHORIZATION": f"Bearer {value}"} if value is not None else {}
    return client.get(URL, **headers)


def test_route_is_the_contract_path():
    assert reverse("product_status") == URL


def test_without_a_configured_token_it_answers_503(client, settings):
    settings.AUTOFIX_STATUS_TOKEN = ""
    response = get(client, "anything")
    assert response.status_code == 503 and response.json() == {"error": "not_configured"}


@pytest.mark.parametrize("value", [None, "", "wrong", TOKEN + "x", TOKEN[:-1]])
def test_wrong_or_missing_token_is_401(client, token, value):
    response = get(client, value)
    assert response.status_code == 401
    assert response["WWW-Authenticate"].startswith("Bearer")
    assert response.json() == {"error": "unauthorized"}


def test_other_schemes_are_refused(client, token):
    assert client.get(URL, HTTP_AUTHORIZATION=f"Token {TOKEN}").status_code == 401


def test_only_get_is_allowed(client, token):
    assert client.post(URL, HTTP_AUTHORIZATION=f"Bearer {TOKEN}").status_code == 405


def test_valid_answer_passes_the_product_pipeline_validator(client, token, settings, seeded):
    response = get(client, TOKEN)
    assert response.status_code == 200
    assert response["Content-Type"] == "application/json"
    assert "no-store" in response["Cache-Control"]
    body = response.json()
    snapshot = parse_status(body, product(settings))
    assert snapshot.product == "autofix"
    assert snapshot.environment == "test"
    assert snapshot.tenants == {"total": 2, "active": 1, "trial": 1, "suspended": 0}
    assert body["tenants"]["onboarding"] == 1 and body["tenants"]["cancelled"] == 0
    assert snapshot.subscriptions == {"active": 1, "trialing": 1, "pastDue": 0}
    assert snapshot.superadmin_url == settings.AUTOFIX_SUPERADMIN_URL


def test_answer_with_no_garages_is_still_valid(client, token, settings):
    body = get(client, TOKEN).json()
    snapshot = parse_status(body, product(settings))
    assert snapshot.status == "operational" and snapshot.alerts == ()
    assert snapshot.tenants["total"] == 0


def test_failures_make_it_degraded_with_critical_alerts(client, token, settings, seeded):
    body = get(client, TOKEN).json()
    snapshot = parse_status(body, product(settings))
    assert snapshot.status == "degraded"
    titles = {alert.title for alert in snapshot.alerts}
    assert "1 Pitline job failed" in titles
    assert "1 custom domain failing verification" in titles
    assert "1 garage onboarding for over 48 hours" in titles
    for alert in snapshot.alerts:
        assert alert.url.startswith(settings.AUTOFIX_SUPERADMIN_URL)


def test_no_personal_or_garage_identifying_data(client, token, seeded):
    raw = get(client, TOKEN).content.decode()
    for secret in (
        "Hartley",
        "Demo Garage",
        "Olivia",
        "•••",
        "+4477",
        "AB12",
        "owner@example.test",
        "hartley-road",
    ):
        assert secret not in raw
    for garage in Garage.objects.all():
        assert str(garage.pk) not in raw


def test_alert_links_are_dropped_on_plain_http(client, token, settings, seeded):
    settings.AUTOFIX_SUPERADMIN_URL = "http://localhost:8000"
    body = get(client, TOKEN).json()
    assert body["alerts"] and all(alert["url"] is None for alert in body["alerts"])


def test_autofix_unreadable_answers_503_without_figures(client, token, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    response = get(client, TOKEN)
    assert response.status_code == 503 and response.json() == {"error": "unavailable"}


def test_environment_is_a_valid_slug(settings):
    settings.APP_ENVIRONMENT = "Production"
    assert status.environment() == "production"
    settings.APP_ENVIRONMENT = "staging_eu"
    assert status.environment() == "staging-eu"
    settings.APP_ENVIRONMENT = "Not valid!"
    assert status.environment() == "development"


def test_checked_at_is_utc_with_an_offset(seeded):
    body = status.payload()
    assert body["checkedAt"].endswith("Z")
    assert all(alert["since"].endswith("Z") for alert in body["alerts"])


def test_alert_times_are_never_in_the_future(af, settings):
    af.make(
        __import__("apps.autofix.models", fromlist=["Job"]).Job,
        status="failed",
        attempts=5,
        finished_at=timezone.now() + timedelta(hours=1),
        last_error="clock skew",
    )
    body = status.payload()
    parse_status(json.loads(json.dumps(body)), product(settings))


def test_the_vendored_validator_still_rejects_bad_payloads(settings):
    good = {
        "product": "autofix",
        "environment": "test",
        "status": "operational",
        "checkedAt": "2026-01-01T10:00:00Z",
        "tenants": {"total": 1, "active": 1, "trial": 0, "suspended": 0},
        "subscriptions": {"active": 1, "trialing": 0, "pastDue": 0},
        "alerts": [],
        "superadminUrl": "https://superadmin.autofix.example.test",
    }
    parse_status(good, product(settings))
    for broken in (
        {**good, "product": "askbridge"},
        {**good, "tenants": {"total": 1, "active": 2, "trial": 0, "suspended": 0}},
        {**good, "subscriptions": {"active": True, "trialing": 0, "pastDue": 0}},
        {**good, "checkedAt": "2026-01-01T10:00:00"},
    ):
        with pytest.raises(InvalidStatus):
            parse_status(broken, product(settings))
