"""Users and roles: the Pitline platform admin link and role rules."""

import pytest
from django.core.exceptions import PermissionDenied, ValidationError

from apps.accounts import services
from apps.accounts.roles import (
    FINANCE,
    SUPERADMIN,
    SUPPORT,
    can_change_autofix,
    can_operate,
    can_support,
    role_label,
)
from apps.audit.models import AuditEvent

from .conftest import ADMIN_ID, HX


def test_role_capabilities(superadmin, support, finance, norole):
    assert can_change_autofix(superadmin) and can_support(superadmin) and can_operate(superadmin)
    assert not can_change_autofix(support) and can_support(support) and can_operate(support)
    assert not can_change_autofix(finance) and not can_support(finance) and not can_operate(finance)
    assert not can_support(norole)
    assert role_label(finance) == "Finance"


def test_linking_is_audited_and_unique(superadmin, make_user):
    other = make_user(SUPPORT)
    with pytest.raises(ValidationError):
        services.link_autofix_admin(other, ADMIN_ID, superadmin)
    superadmin_two = make_user(SUPERADMIN)
    assert services.link_autofix_admin(superadmin_two, "5a000000-0000-4000-8000-0000000000b2", superadmin)
    assert AuditEvent.objects.filter(action="users.autofix_link_changed").count() == 1
    assert not services.link_autofix_admin(superadmin_two, "5a000000-0000-4000-8000-0000000000b2", superadmin)


def test_only_superadmin_links(support, make_user):
    with pytest.raises(PermissionDenied):
        services.link_autofix_admin(make_user(FINANCE), None, support)


def test_user_edit_lists_platform_admins_and_links(client_for, superadmin, make_user, seeded):
    target = make_user(SUPPORT, email="s2@example.test")
    client = client_for(superadmin)
    form = client.get(f"/settings/users/{target.pk}/edit/", **HX)
    assert b"Platform Admin (pa@vitalos.example)" in form.content
    superadmin.autofix_admin_id = None
    superadmin.save()
    response = client.post(
        f"/settings/users/{target.pk}/edit/",
        {"full_name": "", "role": "Support", "is_active": "on", "autofix_admin": ADMIN_ID},
        **HX,
    )
    assert response.status_code == 204
    target.refresh_from_db()
    assert str(target.autofix_admin_id) == ADMIN_ID


def test_user_edit_works_when_autofix_is_down(client_for, superadmin, make_user, settings):
    settings.AUTOFIX_DATABASE_CONFIGURED = False
    target = make_user(SUPPORT)
    assert client_for(superadmin).get(f"/settings/users/{target.pk}/edit/", **HX).status_code == 200


def test_team_page_shows_staff_and_platform_admins(client_for, finance, superadmin, seeded):
    body = client_for(finance).get("/team/").content.decode()
    assert "admin@example.test" in body and "Platform Admin" in body and "Linked" in body


def test_django_admin_is_for_verified_superusers_only(client_for, make_user, superadmin):
    root = make_user(None, is_superuser=True, is_staff=True)
    assert client_for(root).get("/django-admin/").status_code == 200
    assert client_for(superadmin).get("/django-admin/", follow=True).status_code == 403
    unverified = client_for(root, verified=False).get("/django-admin/")
    assert unverified.status_code == 302 and "/login/verify/" in unverified["Location"]
