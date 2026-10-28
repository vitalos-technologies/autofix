import io
import secrets

import pytest
from django.core.management import CommandError, call_command

from apps.accounts.models import User
from apps.accounts.roles import SUPERADMIN, is_superadmin


def run(*args, **kwargs):
    out = io.StringIO()
    call_command(*args, stdout=out, **kwargs)
    return out.getvalue()


def test_create_superadmin_reads_password_from_env(monkeypatch):
    password = secrets.token_urlsafe(16)
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", password)
    output = run("create_superadmin", "--email", "Founder@Example.test")
    assert password not in output
    user = User.objects.get(email="founder@example.test")
    assert user.is_superuser and user.is_staff and user.check_password(password)
    assert user.groups.filter(name=SUPERADMIN).exists() and is_superadmin(user)


def test_create_superadmin_is_idempotent_and_only_resets_on_request(monkeypatch):
    first, second = secrets.token_urlsafe(16), secrets.token_urlsafe(16)
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "founder@example.test")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", first)
    run("create_superadmin")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", second)
    assert "left unchanged" in run("create_superadmin")
    assert User.objects.get().check_password(first)
    assert "Updated password" in run("create_superadmin", "--password")
    assert User.objects.get().check_password(second)
    assert User.objects.count() == 1


def test_create_superadmin_requires_env_password_and_strength(monkeypatch):
    monkeypatch.delenv("BOOTSTRAP_ADMIN_PASSWORD", raising=False)
    with pytest.raises(CommandError, match="BOOTSTRAP_ADMIN_PASSWORD"):
        run("create_superadmin", "--email", "a@example.test")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "short")
    with pytest.raises(CommandError, match="rejected"):
        run("create_superadmin", "--email", "a@example.test")
    assert not User.objects.exists()


def test_create_superadmin_does_not_accept_a_password_value():
    with pytest.raises(CommandError):
        call_command("create_superadmin", "--email", "a@example.test", "--password", "hunter2hunter2")


def test_create_superadmin_never_reactivates_or_repromotes(monkeypatch):
    """It runs on every release, so deliberate deactivation or demotion must survive redeploys."""
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", secrets.token_urlsafe(16))
    run("create_superadmin", "--email", "founder@example.test")
    user = User.objects.get()
    user.is_active = False
    user.is_superuser = False
    user.save()
    user.groups.clear()
    run("create_superadmin", "--email", "founder@example.test")
    run("create_superadmin", "--email", "founder@example.test", "--password")
    user.refresh_from_db()
    assert not user.is_active and not user.is_superuser and not user.groups.exists()


def test_issue_setup_link_prints_one_link_and_audits(monkeypatch):
    from apps.audit.models import AuditEvent

    User.objects.create_user(email="owner@example.test", password=secrets.token_urlsafe(16))
    output = run("issue_setup_link", "--email", "owner@example.test", "--base-url", "https://sa.example.test")
    assert "https://sa.example.test/account/set-password/" in output
    assert AuditEvent.objects.filter(action="auth.setup_link_issued").count() == 1


def test_issue_setup_link_refuses_unknown_accounts():
    with pytest.raises(CommandError):
        run("issue_setup_link", "--email", "nobody@example.test")


def test_create_owner_creates_an_owner_without_a_password():
    run("create_owner", "--email", "Owner@Example.test")
    owner = User.objects.get(email="owner@example.test")
    assert owner.is_primary_owner and is_superadmin(owner) and not owner.has_usable_password()
    assert "left unchanged" in run("create_owner", "--email", "owner@example.test")


def test_migrate_refuses_the_autofix_database(settings):
    settings.AUTOFIX_MIGRATE_GUARD = True
    with pytest.raises(CommandError, match="never migrated"):
        call_command("migrate", database="autofix", verbosity=0)
