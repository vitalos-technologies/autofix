"""System health checks and the footer."""

from django.urls import reverse

from apps.core import health


def test_checks_cover_both_databases_jobs_messaging_and_status(seeded):
    keys = [check.key for check in health.checks()]
    assert keys == ["database", "autofix", "jobs", "messaging", "status"]


def test_failed_jobs_and_messages_need_a_look(seeded):
    results = {check.key: check for check in health.checks()}
    assert results["jobs"].status == "warn" and results["messaging"].status == "warn"
    assert health.overall(list(results.values()))["status"] == "warn"


def test_quiet_system_is_all_normal():
    results = health.checks()
    overall = health.overall(results)
    assert overall["status"] == "ok" and overall["summary"] == "All systems normal"


def test_unconnected_autofix_fails_clearly(settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    results = {check.key: check for check in health.checks()}
    assert results["autofix"].status == "fail" and "AUTOFIX_DATABASE_URL" in results["autofix"].summary


def test_status_token_check_never_shows_the_token(settings):
    settings.AUTOFIX_STATUS_TOKEN = "secret-token-value-0123456789abcdef"
    results = {check.key: check for check in health.checks()}
    assert "secret-token-value" not in str(results["status"])


def test_footer_and_page(client_for, finance, seeded):
    client = client_for(finance)
    assert b"need a look" in client.get(reverse("core:health_footer")).content
    assert client.get(reverse("core:health")).status_code == 200


def test_healthz_reports_unavailable_database(client, monkeypatch):
    from apps.core import middleware

    class Broken:
        def cursor(self):
            raise RuntimeError("down")

    monkeypatch.setattr(middleware, "connection", Broken())
    response = client.get("/healthz/")
    assert response.status_code == 503 and response.json() == {"status": "unavailable"}


def test_autofix_sessions_that_are_not_read_only_need_a_look(settings):
    from django.db import connections

    if connections["autofix"].vendor != "postgresql":
        import pytest

        pytest.skip("read-only sessions are a PostgreSQL setting")
    settings.AUTOFIX_EXPECT_READ_ONLY = True
    results = {check.key: check for check in health.checks()}
    assert results["autofix"].status == "warn" and "not read-only" in results["autofix"].summary
