import secrets

import pytest
from django.test import Client, override_settings
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice

from apps.accounts.models import User
from apps.accounts.roles import FINANCE, SUPERADMIN
from apps.accounts.services import set_role


def code_for(device, offset=0):
    return f"{totp(device.bin_key, step=device.step, t0=device.t0, digits=device.digits, drift=offset):06d}"


def reset_throttle(device):
    device.refresh_from_db()
    device.throttling_failure_count = 0
    device.throttling_failure_timestamp = None
    device.last_t = -1
    device.save()


@pytest.fixture
def password():
    return secrets.token_urlsafe(16)


def test_finance_password_login_and_logout(password):
    user = User.objects.create_user(email="finance@example.test", password=password)
    set_role(user, FINANCE, actor=None)
    client = Client()
    response = client.post("/login/", {"email": "FINANCE@example.test", "password": password})
    assert response.status_code == 302 and response.url == "/"
    assert client.get("/").status_code == 200
    assert client.get("/logout/").status_code == 405  # logout is POST-only
    assert client.post("/logout/").status_code == 302
    assert client.get("/").status_code == 302


def test_wrong_password_shows_generic_error(password):
    User.objects.create_user(email="finance@example.test", password=password)
    response = Client().post("/login/", {"email": "finance@example.test", "password": "not-the-password"})
    assert response.status_code == 200 and b"not recognised" in response.content


@override_settings(AXES_FAILURE_LIMIT=3)
def test_axes_locks_out_after_repeated_failures(password):
    User.objects.create_user(email="target@example.test", password=password)
    client = Client()
    for _ in range(2):
        assert (
            client.post(
                "/login/", {"email": "target@example.test", "password": "wrong-password-1"}
            ).status_code
            == 200
        )
    locked = client.post("/login/", {"email": "target@example.test", "password": "wrong-password-1"})
    assert locked.status_code == 429 and b"Too many failed attempts" in locked.content
    # Even the right password is refused while locked out.
    assert client.post("/login/", {"email": "target@example.test", "password": password}).status_code == 429


def test_superadmin_enrols_and_uses_totp(password):
    user = User.objects.create_user(email="founder@example.test", password=password)
    set_role(user, SUPERADMIN, actor=None)
    client = Client()
    response = client.post(
        "/login/", {"email": "founder@example.test", "password": password, "next": "/garages/"}
    )
    assert response.status_code == 302 and response.url.startswith("/account/2fa/setup/")
    setup = client.get(response.url)
    assert setup.status_code == 200 and b"<svg" in setup.content
    assert b"global-search" not in setup.content  # no app chrome before the second factor
    assert (
        b'data-autosubmit="6"' in setup.content and b"js/otp.js" in setup.content
    )  # submits on the sixth digit
    device = TOTPDevice.objects.get(user=user, confirmed=False)
    assert client.post("/account/2fa/setup/", {"token": "000000"}).status_code == 200
    reset_throttle(device)  # failures are throttled; a real user waits a moment before retrying
    done = client.post("/account/2fa/setup/?next=/garages/", {"token": code_for(device), "next": "/garages/"})
    assert done.status_code == 302 and done.url == "/garages/"
    device.refresh_from_db()
    assert device.confirmed
    assert client.get("/garages/").status_code == 200
    # A fresh session must pass the TOTP check.
    client.post("/logout/")
    response = client.post("/login/", {"email": "founder@example.test", "password": password})
    assert response.url.startswith("/login/verify/")
    assert client.get("/").url.startswith("/login/verify/")
    verify = client.get("/login/verify/")
    assert b'data-autosubmit="6"' in verify.content and b"js/otp.js" in verify.content
    bad = client.post("/login/verify/", {"token": "123456"})
    assert bad.status_code == 200 and b"not valid" in bad.content
    reset_throttle(device)
    ok = client.post("/login/verify/", {"token": code_for(device)})
    assert ok.status_code == 302 and ok.url == "/"
    assert client.get("/").status_code == 200


def test_open_redirects_are_ignored(password):
    user = User.objects.create_user(email="finance@example.test", password=password)
    set_role(user, FINANCE, actor=None)
    response = Client().post(
        "/login/", {"email": "finance@example.test", "password": password, "next": "https://evil.example/"}
    )
    assert response.url == "/"


def test_password_policy_requires_twelve_characters(superadmin, client_for):
    client = client_for(superadmin)
    response = client.post(
        "/settings/users/new/",
        {"email": "new@example.test", "full_name": "New", "role": "Finance", "password": "Sh0rt-pass"},
        HTTP_HX_REQUEST="true",
    )
    assert response.status_code == 200 and b"at least 12 characters" in response.content
    assert not User.objects.filter(email="new@example.test").exists()


def test_superadmin_creates_user_and_changes_role(superadmin, client_for, password):
    client = client_for(superadmin)
    created = client.post(
        "/settings/users/new/",
        {"email": "lead@example.test", "full_name": "Lee Lead", "role": "Support", "password": password},
        HTTP_HX_REQUEST="true",
    )
    assert created.status_code == 204 and "vsa-close-modal" in created["HX-Trigger"]
    user = User.objects.get(email="lead@example.test")
    assert user.groups.filter(name="Support").exists()
    edited = client.post(
        f"/settings/users/{user.pk}/edit/",
        {"full_name": "Lee Lead", "role": "Finance", "is_active": "on"},
        HTTP_HX_REQUEST="true",
    )
    assert edited.status_code == 204
    assert list(user.groups.values_list("name", flat=True)) == ["Finance"]
    # Removing your own SuperAdmin role is refused.
    own = client.post(
        f"/settings/users/{superadmin.pk}/edit/",
        {"full_name": "", "role": "Finance", "is_active": "on"},
        HTTP_HX_REQUEST="true",
    )
    assert own.status_code == 200 and b"cannot remove your own" in own.content


def test_session_and_cookie_settings(settings):
    assert settings.SESSION_COOKIE_AGE == 8 * 60 * 60
    assert settings.SESSION_COOKIE_HTTPONLY and settings.CSRF_COOKIE_HTTPONLY
    min_length = [v for v in settings.AUTH_PASSWORD_VALIDATORS if "MinimumLength" in v["NAME"]][0]
    assert min_length["OPTIONS"]["min_length"] == 12


def test_superuser_role_cannot_be_changed_in_the_app(superadmin, make_user, client_for):
    root = make_user(None, is_superuser=True, is_staff=True)
    response = client_for(superadmin).post(
        f"/settings/users/{root.pk}/edit/",
        {"full_name": "", "role": "Finance", "is_active": "on"},
        HTTP_HX_REQUEST="true",
    )
    assert response.status_code == 200 and b"Django superuser" in response.content
    assert not root.groups.filter(name="Finance").exists()
