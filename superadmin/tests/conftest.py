import secrets

import pytest
from django.db import connections
from django.test import Client
from django_otp import DEVICE_ID_SESSION_KEY
from django_otp.plugins.otp_totp.models import TOTPDevice

from apps.accounts.models import User
from apps.accounts.roles import FINANCE, SUPERADMIN, SUPPORT
from apps.accounts.services import set_role
from apps.autofix.models import AutofixModel

from .factories import AutofixFactory

DATABASES = ["default", "autofix"]
ADMIN_ID = "5a000000-0000-4000-8000-0000000000a1"


def pytest_collection_modifyitems(items):
    """Every unit test gets both test databases (the ``autofix`` one holds the unmanaged tables)."""
    for item in items:
        if item.get_closest_marker("integration") or item.get_closest_marker("django_db"):
            continue
        item.add_marker(pytest.mark.django_db(databases=DATABASES))


def autofix_models():
    from django.apps import apps

    return [model for model in apps.get_app_config("autofix").get_models() if issubclass(model, AutofixModel)]


@pytest.fixture(scope="session")
def django_db_setup(django_db_setup, django_db_blocker):
    """Create the unmanaged Autofix tables in the ``autofix`` test database (the router never migrates it)."""
    with django_db_blocker.unblock():
        connection = connections["autofix"]
        existing = set(connection.introspection.table_names())
        with connection.schema_editor() as editor:
            for model in autofix_models():
                if model._meta.db_table not in existing:
                    editor.create_model(model)
    yield


def random_password() -> str:
    return secrets.token_urlsafe(16)


@pytest.fixture
def make_user(db):
    def _make(role=None, email=None, **extra):
        user = User.objects.create_user(
            email=email or f"{secrets.token_hex(4)}@example.test", password=random_password(), **extra
        )
        if role:
            set_role(user, role, actor=None)
        return user

    return _make


@pytest.fixture
def superadmin(make_user):
    return make_user(SUPERADMIN, email="admin@example.test", autofix_admin_id=ADMIN_ID)


@pytest.fixture
def unlinked_superadmin(make_user):
    return make_user(SUPERADMIN, email="unlinked@example.test")


@pytest.fixture
def support(make_user):
    return make_user(SUPPORT, email="support@example.test")


@pytest.fixture
def finance(make_user):
    return make_user(FINANCE, email="finance@example.test")


@pytest.fixture
def norole(make_user):
    return make_user(None, email="norole@example.test")


def login(client: Client, user, verified: bool = True) -> Client:
    client.force_login(user)
    if verified:
        device, _ = TOTPDevice.objects.get_or_create(user=user, name="test", defaults={"confirmed": True})
        session = client.session
        session[DEVICE_ID_SESSION_KEY] = device.persistent_id
        session.save()
    return client


@pytest.fixture
def client_for(db):
    def _client(user, verified: bool = True) -> Client:
        return login(Client(), user, verified)

    return _client


@pytest.fixture
def af():
    """Insert Autofix rows (raw SQL into the test database; the ORM refuses to write them)."""
    return AutofixFactory()


@pytest.fixture
def seeded(af):
    """Two garages with team, bookings, domains, jobs, messages and an agreement."""
    return af.scenario()


HX = {"HTTP_HX_REQUEST": "true"}
