"""The router and the models never migrate or write the ``autofix`` alias."""

import uuid

import pytest
from django.apps import apps
from django.db import connections, router

from apps.accounts.models import User
from apps.autofix.models import AutofixModel, Garage, ReadOnlyModelError
from apps.autofix.router import AutofixRouter

AUTOFIX_MODELS = [m for m in apps.get_app_config("autofix").get_models() if issubclass(m, AutofixModel)]
OTHER_APPS = ["accounts", "audit", "notifications", "auth", "contenttypes", "sessions", "otp_totp", "axes"]


@pytest.mark.parametrize("model", AUTOFIX_MODELS, ids=lambda m: m.__name__)
def test_autofix_models_are_unmanaged_and_read_from_the_autofix_alias(model):
    assert model._meta.managed is False
    assert router.db_for_read(model) == "autofix"


@pytest.mark.parametrize("model", AUTOFIX_MODELS, ids=lambda m: m.__name__)
def test_router_refuses_to_route_a_write(model):
    with pytest.raises(ReadOnlyModelError):
        router.db_for_write(model)


@pytest.mark.parametrize("app_label", ["autofix", *OTHER_APPS])
def test_nothing_is_ever_migrated_on_the_autofix_alias(app_label):
    assert AutofixRouter().allow_migrate("autofix", app_label) is False
    assert AutofixRouter().allow_migrate("autofix_live", app_label) is False


def test_autofix_app_is_never_migrated_on_default():
    assert AutofixRouter().allow_migrate("default", "autofix", "garage") is False
    assert AutofixRouter().allow_migrate("default", "accounts", "user") is None


def test_default_models_still_write_to_default():
    assert router.db_for_write(User) == "default"
    assert router.db_for_read(User) == "default"


def test_relations_across_databases_are_refused(af):
    garage = af.garage()
    user = User(email="x@example.test")
    assert AutofixRouter().allow_relation(garage, user) is False
    assert AutofixRouter().allow_relation(garage, garage) is True


def test_model_save_and_delete_raise(af):
    garage = af.garage()
    garage.name = "Changed"
    with pytest.raises(ReadOnlyModelError):
        garage.save()
    with pytest.raises(ReadOnlyModelError):
        garage.delete()
    assert Garage.objects.get(pk=garage.pk).name != "Changed"


@pytest.mark.parametrize(
    "call",
    [
        lambda qs: qs.update(name="x"),
        lambda qs: qs.delete(),
        lambda qs: qs.create(id=uuid.uuid4(), name="x"),
        lambda qs: qs.get_or_create(id=uuid.uuid4()),
        lambda qs: qs.update_or_create(id=uuid.uuid4()),
        lambda qs: qs.bulk_create([Garage(id=uuid.uuid4())]),
        lambda qs: qs.bulk_update([], ["name"]),
    ],
)
def test_queryset_writes_raise(af, call):
    af.garage()
    with pytest.raises(ReadOnlyModelError):
        call(Garage.objects.all())


def test_migrate_on_default_creates_no_autofix_table():
    tables = set(connections["default"].introspection.table_names())
    for model in AUTOFIX_MODELS:
        assert model._meta.db_table not in tables


def test_test_autofix_database_holds_only_autofix_tables():
    tables = set(connections["autofix"].introspection.table_names())
    assert "accounts_user" not in tables and "django_session" not in tables
