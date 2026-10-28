"""Garages list: filters, sorting, HTMX partials, bulk bar and CSV export."""

import csv
import io
from unittest import mock

import pytest
from django.urls import reverse

from apps.audit.models import AuditEvent
from apps.autofix import db

from .conftest import HX


def rows(response):
    return list(csv.reader(io.StringIO(response.content.decode())))


def test_list_filters_and_shows_status(client_for, finance, seeded):
    client = client_for(finance)
    body = client.get(reverse("autofix:garages"), {"status": "onboarding"}).content.decode()
    assert "Demo Garage B" in body and "Hartley Road Motors" not in body
    assert "Domain failing" in body


def test_htmx_filter_returns_only_the_table(client_for, finance, seeded):
    response = client_for(finance).get(
        reverse("autofix:garages"), {"q": "hartley"}, HTTP_HX_TARGET="garage-results", **HX
    )
    body = response.content.decode()
    assert "<html" not in body and 'id="garage-results"' in body and "Hartley Road Motors" in body


@pytest.mark.parametrize(
    "sort", ["name", "plan", "status", "team", "bookings", "last", "joined", "evil;drop"]
)
def test_sorting_is_whitelisted(client_for, finance, seeded, sort):
    assert (
        client_for(finance).get(reverse("autofix:garages"), {"sort": sort, "dir": "asc"}).status_code == 200
    )


def test_bulk_bar_offers_status_change_only_to_superadmin(client_for, superadmin, finance, seeded):
    assert "Change status" in client_for(superadmin).get(reverse("autofix:garages")).content.decode()
    assert "Change status" not in client_for(finance).get(reverse("autofix:garages")).content.decode()


def test_export_has_business_fields_only_and_is_audited(client_for, finance, seeded):
    response = client_for(finance).get(reverse("autofix:garages_export"))
    assert response["Content-Type"].startswith("text/csv")
    data = rows(response)
    assert data[0] == [
        "id",
        "name",
        "slug",
        "plan",
        "status",
        "team",
        "bookings_30d",
        "last_booking_at",
        "signed_up_at",
    ]
    assert len(data) == 3
    assert AuditEvent.objects.filter(action="autofix.garages_exported").count() == 1


def test_export_escapes_formula_cells(client_for, finance, af):
    af.garage(name='=HYPERLINK("http://evil")', slug="evil")
    data = rows(client_for(finance).get(reverse("autofix:garages_export")))
    assert data[1][1].startswith("'=")


def test_export_respects_filters(client_for, finance, seeded):
    data = rows(client_for(finance).get(reverse("autofix:garages_export"), {"plan": "growth"}))
    assert [row[2] for row in data[1:]] == ["hartley-road"]


def test_bulk_export_of_selected_rows(client_for, finance, seeded):
    response = client_for(finance).post(
        reverse("autofix:garages_bulk"), {"action": "export", "ids": [str(seeded["demo"].pk)]}
    )
    assert [row[2] for row in rows(response)[1:]] == ["demo-b"]


def test_bulk_rejects_malformed_ids(client_for, finance, seeded):
    response = client_for(finance).post(
        reverse("autofix:garages_bulk"), {"action": "export", "ids": ["nope"]}
    )
    assert response.status_code == 400


def test_bulk_needs_a_selection(client_for, finance, seeded):
    response = client_for(finance).post(reverse("autofix:garages_bulk"), {"action": "export"})
    assert response.status_code == 302


def test_bulk_status_needs_superadmin(client_for, support, seeded):
    response = client_for(support).post(
        reverse("autofix:garages_bulk"), {"action": "status", "ids": [str(seeded["demo"].pk)]}
    )
    assert response.status_code == 403


def test_bulk_status_confirms_then_calls_once_per_garage(client_for, superadmin, seeded):
    ids = [str(seeded["demo"].pk), str(seeded["hartley"].pk)]
    client = client_for(superadmin)
    confirm = client.post(reverse("autofix:garages_bulk"), {"action": "status", "ids": ids})
    assert confirm.status_code == 200 and b"Change status of 2 garages" in confirm.content
    with mock.patch.object(db, "call_platform_function", return_value={}) as call:
        done = client.post(
            reverse("autofix:garages_bulk"),
            {
                "action": "status",
                "ids": ids,
                "confirm": "1",
                "status": "suspended",
                "reason": "Fraud review today",
            },
        )
    assert done.status_code == 302
    assert call.call_count == 2
    assert {c.args[1][2] for c in call.call_args_list} == {"suspended"}
    assert AuditEvent.objects.filter(action="autofix.garage_updated").count() == 2


def test_bulk_status_skips_garages_already_in_that_status(client_for, superadmin, seeded):
    ids = [str(seeded["hartley"].pk)]
    with mock.patch.object(db, "call_platform_function") as call:
        client_for(superadmin).post(
            reverse("autofix:garages_bulk"),
            {
                "action": "status",
                "ids": ids,
                "confirm": "1",
                "status": "active",
                "reason": "No change needed",
            },
        )
    call.assert_not_called()


def test_unknown_bulk_action_is_400(client_for, superadmin, seeded):
    response = client_for(superadmin).post(
        reverse("autofix:garages_bulk"), {"action": "delete", "ids": [str(seeded["demo"].pk)]}
    )
    assert response.status_code == 400


def test_unavailable_autofix_shows_a_message(client_for, finance, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    response = client_for(finance).get(reverse("autofix:garages"))
    assert response.status_code == 503 and b"not connected" in response.content


def test_overview_survives_autofix_being_down(client_for, finance, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    response = client_for(finance).get(reverse("core:overview"))
    assert response.status_code == 200 and b"autofix-unavailable" in response.content


def test_garage_detail_shows_actions_by_role(client_for, superadmin, support, finance, seeded):
    url = reverse("autofix:garage", args=[seeded["hartley"].pk])
    admin_body = client_for(superadmin).get(url).content.decode()
    assert 'data-testid="view-as-support"' in admin_body and 'data-testid="change-plan"' in admin_body
    support_body = client_for(support).get(url).content.decode()
    assert 'data-testid="view-as-support"' in support_body and 'data-testid="change-plan"' not in support_body
    finance_body = client_for(finance).get(url).content.decode()
    assert (
        'data-testid="view-as-support"' not in finance_body
        and 'data-testid="change-plan"' not in finance_body
    )


def test_plan_tab_explains_a_missing_link(client_for, unlinked_superadmin, seeded):
    url = reverse("autofix:garage_tab", args=[seeded["hartley"].pk, "plan"])
    assert b"not linked to an Autofix platform admin" in client_for(unlinked_superadmin).get(url).content


def test_plan_tab_shows_history_from_the_platform_log(client_for, finance, seeded):
    url = reverse("autofix:garage_tab", args=[seeded["hartley"].pk, "plan"])
    body = client_for(finance).get(url).content.decode()
    assert "Status: active → suspended" in body and "Unpaid invoice" in body


def test_domains_page_offers_recheck_only_for_pending_custom_domains(client_for, superadmin, seeded):
    body = client_for(superadmin).get(reverse("autofix:domains")).content.decode()
    assert reverse("autofix:domain_recheck", args=[seeded["pending_domain"].pk]) in body
    assert reverse("autofix:domain_recheck", args=[seeded["failed_domain"].pk]) not in body
    assert "Garage presses Try again" in body


def test_domains_page_filters(client_for, support, seeded):
    body = client_for(support).get(reverse("autofix:domains"), {"kind": "subdomain"}).content.decode()
    assert "hartley-road.autofix.vitalos.co.uk" in body and "book.demob.example" not in body
