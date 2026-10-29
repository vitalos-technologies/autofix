"""Every page renders for the roles allowed to see it, with Autofix data present."""

import pytest
from django.urls import reverse

from .conftest import HX

PAGES = [
    ("core:overview", []),
    ("autofix:garages", []),
    ("autofix:signups", []),
    ("autofix:messaging", []),
    ("autofix:activity", []),
    ("autofix:team", []),
    ("core:help", []),
    ("core:health", []),
    ("notifications:list", []),
    ("notifications:preferences", []),
    ("accounts:settings_tokens", []),
    ("accounts:account", []),
]
OPERATE_PAGES = ["autofix:jobs", "autofix:domains", "autofix:enquiries"]
SUPERADMIN_PAGES = ["audit:trail", "autofix:platform_audit", "accounts:settings_users"]


@pytest.mark.parametrize(("name", "args"), PAGES)
def test_pages_render_for_superadmin(client_for, superadmin, seeded, name, args):
    response = client_for(superadmin).get(reverse(name, args=args))
    assert response.status_code == 200, name


@pytest.mark.parametrize("name", OPERATE_PAGES + SUPERADMIN_PAGES)
def test_operational_pages_render_for_superadmin(client_for, superadmin, seeded, name):
    assert client_for(superadmin).get(reverse(name)).status_code == 200


@pytest.mark.parametrize("name", OPERATE_PAGES)
def test_support_sees_operational_pages(client_for, support, seeded, name):
    assert client_for(support).get(reverse(name)).status_code == 200


@pytest.mark.parametrize("name", OPERATE_PAGES + SUPERADMIN_PAGES)
def test_finance_is_refused_operational_pages(client_for, finance, seeded, name):
    assert client_for(finance).get(reverse(name)).status_code == 403


@pytest.mark.parametrize("name", SUPERADMIN_PAGES)
def test_support_is_refused_superadmin_pages(client_for, support, seeded, name):
    assert client_for(support).get(reverse(name)).status_code == 403


TABS = ["overview", "team", "bookings", "domains", "messaging", "plan", "agreements", "audit"]


@pytest.mark.parametrize("tab", TABS)
def test_garage_detail_tabs_render(client_for, superadmin, seeded, tab):
    garage = seeded["hartley"]
    client = client_for(superadmin)
    page = client.get(reverse("autofix:garage", args=[garage.pk]) + f"?tab={tab}")
    assert page.status_code == 200
    assert f'data-testid="tab-{tab}"' in page.content.decode()
    partial = client.get(reverse("autofix:garage_tab", args=[garage.pk, tab]), **HX)
    assert partial.status_code == 200
    assert "<html" not in partial.content.decode()


def test_unknown_tab_is_404(client_for, superadmin, seeded):
    garage = seeded["hartley"]
    assert (
        client_for(superadmin).get(reverse("autofix:garage_tab", args=[garage.pk, "nope"])).status_code == 404
    )


def test_unknown_garage_is_404(client_for, superadmin, seeded):
    url = reverse("autofix:garage", args=["00000000-0000-4000-8000-000000000000"])
    assert client_for(superadmin).get(url).status_code == 404


def test_malformed_garage_id_is_404(client_for, superadmin, seeded):
    assert client_for(superadmin).get("/garages/not-a-uuid/").status_code == 404


def test_overview_shows_kpis_and_attention(client_for, superadmin, seeded):
    body = client_for(superadmin).get(reverse("core:overview")).content.decode()
    for key in (
        "garages_total",
        "garages_active",
        "bookings_today",
        "bookings_30d",
        "won_back_30d",
        "jobs_failed",
    ):
        assert f'data-testid="kpi-{key}"' in body
    assert "Demo Garage B has been onboarding" in body
    assert "book.demob.example is failing verification" in body
    assert "Job reminders.send failed" in body


def test_overview_never_shows_raw_contact_details(client_for, superadmin, seeded):
    body = client_for(superadmin).get(reverse("core:overview")).content.decode()
    assert "+447700900123" not in body
    assert "AB12 CDE" not in body
    assert "owner@example.test" not in body


def test_search_finds_garages_and_domains(client_for, superadmin, seeded):
    client = client_for(superadmin)
    body = client.get(reverse("core:search"), {"q": "hartley"}, **HX).content.decode()
    assert "Hartley Road Motors" in body
    assert "book.hartleyroad.example" in body


def test_palette_lists_pages_and_garages(client_for, superadmin, seeded):
    body = client_for(superadmin).get(reverse("core:palette"), {"q": "demo"}).content.decode()
    assert "Demo Garage B" in body


def test_anonymous_is_sent_to_login(client):
    response = client.get(reverse("core:overview"))
    assert response.status_code == 302
    assert reverse("accounts:login") in response["Location"]


def test_user_without_role_is_refused(client_for, norole):
    assert client_for(norole).get(reverse("core:overview")).status_code == 403
