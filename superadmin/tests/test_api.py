"""Read-only REST API: tokens, roles, no personal data, schema and docs."""

from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from apps.accounts.models import ApiToken


@pytest.fixture
def token(finance):
    _, raw = ApiToken.issue(finance, "Power BI")
    return raw


def api(raw, path, method="get"):
    return getattr(Client(), method)(path, HTTP_AUTHORIZATION=f"Bearer {raw}")


def test_garages_list_with_a_token(token, seeded):
    response = api(token, "/api/v1/garages/")
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 2
    assert set(body["results"][0]) == {
        "id",
        "slug",
        "name",
        "plan",
        "plan_key",
        "plan_name",
        "trial_ends_at",
        "status",
        "timezone",
        "mot_enabled",
        "onboarding_started_at",
        "onboarding_completed_at",
        "cancelled_at",
        "created_at",
    }


def test_filters(token, seeded):
    assert api(token, "/api/v1/garages/?plan=essentials").json()["count"] == 1
    assert api(token, "/api/v1/garages/?plan=trial").json()["results"][0]["plan_name"] == "Pro (trial)"
    assert api(token, "/api/v1/domains/?status=failed").json()["count"] == 1


def test_jobs_errors_are_redacted(token, seeded):
    job = api(token, "/api/v1/jobs/?status=failed").json()["results"][0]
    assert "+447700900123" not in job["last_error"] and "[reg]" in job["last_error"]
    assert "payload" not in job


def test_counts(token, seeded):
    body = api(token, "/api/v1/counts/").json()
    assert body["tenants"]["total"] == 2 and body["subscriptions"] == {
        "active": 1,
        "trialing": 1,
        "pastDue": 0,
    }


def test_api_is_read_only(token, seeded):
    assert api(token, "/api/v1/garages/", "post").status_code == 403
    assert api(token, "/api/v1/garages/", "delete").status_code in (403, 405)


def test_bad_revoked_and_expired_tokens(finance, seeded):
    assert api("afsa_nope", "/api/v1/garages/").status_code == 401
    revoked, raw = ApiToken.issue(finance, "Old")
    revoked.revoked_at = timezone.now()
    revoked.save()
    assert api(raw, "/api/v1/garages/").status_code == 401
    _, expired = ApiToken.issue(finance, "Expired", expires_at=timezone.now() - timedelta(days=1))
    assert api(expired, "/api/v1/garages/").status_code == 401


def test_token_of_a_user_without_role_is_refused(norole, seeded):
    _, raw = ApiToken.issue(norole, "x")
    assert api(raw, "/api/v1/garages/").status_code == 403


def test_tokens_are_stored_hashed(finance):
    token, raw = ApiToken.issue(finance, "x")
    assert raw.startswith("afsa_") and raw not in token.key_hash and token.prefix == raw[5:13]


def test_api_answers_503_when_autofix_is_down(token, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    assert api(token, "/api/v1/garages/").status_code == 503
    assert api(token, "/api/v1/counts/").status_code == 503


def test_schema_and_docs(client_for, finance):
    client = client_for(finance)
    schema = client.get("/api/schema/")
    assert schema.status_code == 200 and b"Autofix Super Admin API" in schema.content
    assert client.get("/api/docs/").status_code == 200
    assert Client().get("/api/schema/").status_code in (401, 403)


def test_settings_page_creates_and_revokes_tokens(client_for, finance):
    client = client_for(finance)
    created = client.post("/settings/tokens/", {"name": "Script", "expires_in_days": 30})
    assert (
        created.status_code == 200 and b"afsa_" in created.content and created["Cache-Control"] == "no-store"
    )
    token = ApiToken.objects.get(name="Script")
    assert client.post(f"/settings/tokens/{token.pk}/revoke/").status_code == 302
    token.refresh_from_db()
    assert token.revoked_at is not None
