"""Path mode (DECISIONS D18): the app at pitline.co.uk/superadmin behind the Pitline proxy."""

import pytest
from django.test import Client, RequestFactory
from django.urls import reverse, set_script_prefix

from apps.core.http import client_ip
from apps.core.middleware import ProxyGateMiddleware, loggable_path
from apps.core.wsgi import PrefixMiddleware

from .conftest import login
from .test_security import _check_prod

SECRET = "s" * 40
PREFIX = "/superadmin"
GATE = {"HTTP_X_AUTOFIX_SUPERADMIN_PROXY": SECRET}


@pytest.fixture
def path_mode(settings):
    settings.FORCE_SCRIPT_NAME = PREFIX
    settings.URL_PREFIX = PREFIX
    settings.COOKIE_PATH = f"{PREFIX}/"
    settings.SESSION_COOKIE_PATH = f"{PREFIX}/"
    settings.CSRF_COOKIE_PATH = f"{PREFIX}/"
    settings.STATIC_URL = f"{PREFIX}/static/"
    settings.SUPERADMIN_PROXY_SECRET = SECRET
    settings.ALLOWED_HOSTS = ["pitline.co.uk", "origin.internal", "testserver"]
    # What django.setup() does for management commands, and the handler for each request.
    set_script_prefix(f"{PREFIX}/")
    yield
    set_script_prefix("/")


# --- WSGI prefix -------------------------------------------------------------------------------


def _wsgi(path):
    seen = {}

    def app(environ, start_response):
        seen.update(script=environ["SCRIPT_NAME"], path=environ["PATH_INFO"])
        start_response("200 OK", [])
        return [b"app"]

    statuses = []
    body = PrefixMiddleware(app, PREFIX)(
        {"PATH_INFO": path, "SCRIPT_NAME": ""}, lambda s, h: statuses.append(s)
    )
    return statuses[0], b"".join(body), seen


@pytest.mark.parametrize(
    ("path", "script", "path_info"),
    [("/superadmin/jobs/", PREFIX, "/jobs/"), ("/superadmin/", PREFIX, "/"), ("/superadmin", PREFIX, "/")],
)
def test_prefix_moves_to_script_name(path, script, path_info):
    status, _, seen = _wsgi(path)
    assert status.startswith("200") and seen == {"script": script, "path": path_info}


@pytest.mark.parametrize("path", ["/", "/jobs/", "/superadminx/", "/admin/garages/", "/static/css/app.css"])
def test_paths_outside_the_prefix_are_a_bare_404(path):
    status, body, seen = _wsgi(path)
    assert status.startswith("404") and body == b"Not found" and not seen


def test_health_probe_stays_at_the_root():
    status, _, seen = _wsgi("/healthz/")
    assert status.startswith("200") and seen["path"] == "/healthz/"


# --- Proxy gate --------------------------------------------------------------------------------


@pytest.mark.parametrize("headers", [{}, {"HTTP_X_AUTOFIX_SUPERADMIN_PROXY": "wrong"}])
def test_requests_without_the_proxy_secret_get_a_bare_404(path_mode, db, headers):
    response = Client().get("/login/", **headers)
    assert response.status_code == 404 and response.content == b"Not found"
    assert "afsa_csrftoken" not in response.cookies


def test_health_probe_needs_no_secret(path_mode, db):
    assert Client().get("/healthz/").status_code == 200


def test_proxied_sign_in_page_lives_under_the_prefix(path_mode, db):
    response = Client().get("/login/", HTTP_X_AUTOFIX_SUPERADMIN_HOST="pitline.co.uk", **GATE)
    body = response.content.decode()
    assert response.status_code == 200
    assert 'action="/superadmin/login/' in body or "/superadmin/login/" in body
    assert "/superadmin/static/" in body and 'data-cookie-path="/superadmin/"' in body
    assert response["X-Robots-Tag"] == "noindex, nofollow" and "no-store" in response["Cache-Control"]


def test_reverse_and_redirects_carry_the_prefix(path_mode, db):
    assert reverse("autofix:jobs") == "/superadmin/jobs/"
    response = Client().get("/jobs/", **GATE)
    assert response.status_code == 302 and response["Location"].startswith("/superadmin/login/")


def test_session_and_csrf_cookies_are_scoped_to_the_prefix(path_mode, superadmin):
    client = Client()
    client.get("/login/", **GATE)
    assert client.cookies["afsa_csrftoken"]["path"] == "/superadmin/"
    login(client, superadmin)
    response = client.get("/", **GATE)
    assert response.status_code == 200
    assert 'aria-current="page" data-nav="overview"' in response.content.decode()


def test_the_proxy_secret_never_reaches_the_view(path_mode, settings):
    seen = {}

    def view(request):
        seen.update(request.META)
        return None

    request = RequestFactory().get("/", **GATE)
    ProxyGateMiddleware(view)(request)
    assert "HTTP_X_AUTOFIX_SUPERADMIN_PROXY" not in seen and SECRET not in str(seen)


def test_client_ip_and_host_come_from_the_proxy_only_behind_the_gate(path_mode):
    captured = {}

    def view(request):
        captured["ip"] = client_ip(request)
        captured["host"] = request.get_host()

    headers = {
        "HTTP_X_AUTOFIX_SUPERADMIN_CLIENT_IP": "203.0.113.9",
        "HTTP_X_AUTOFIX_SUPERADMIN_HOST": "pitline.co.uk",
        "HTTP_HOST": "origin.internal",
        "REMOTE_ADDR": "10.0.0.5",
    }
    ProxyGateMiddleware(view)(RequestFactory().get("/", **headers, **GATE))
    assert captured == {"ip": "203.0.113.9", "host": "pitline.co.uk"}


def test_proxy_headers_are_ignored_without_the_gate(settings):
    settings.SUPERADMIN_PROXY_SECRET = ""
    captured = {}

    def view(request):
        captured["ip"] = client_ip(request)
        captured["meta"] = dict(request.META)

    request = RequestFactory().get(
        "/", HTTP_X_AUTOFIX_SUPERADMIN_CLIENT_IP="203.0.113.9", REMOTE_ADDR="10.0.0.5"
    )
    ProxyGateMiddleware(view)(request)
    assert captured["ip"] == "10.0.0.5" and "HTTP_X_AUTOFIX_SUPERADMIN_CLIENT_IP" not in captured["meta"]


def test_a_bad_client_ip_header_falls_back_to_the_connection(path_mode):
    captured = {}

    def view(request):
        captured["ip"] = client_ip(request)

    request = RequestFactory().get(
        "/", HTTP_X_AUTOFIX_SUPERADMIN_CLIENT_IP="not-an-ip", REMOTE_ADDR="10.0.0.5", **GATE
    )
    ProxyGateMiddleware(view)(request)
    assert captured["ip"] == "10.0.0.5"


def test_setup_link_tokens_are_redacted_under_the_prefix():
    assert (
        loggable_path("/superadmin/account/set-password/MQ/abc-123/")
        == "/superadmin/account/set-password/[redacted]/"
    )
    assert loggable_path("/account/set-password/MQ/abc-123/") == "/account/set-password/[redacted]/"


def test_attention_links_carry_the_prefix(path_mode, superadmin, seeded):
    from apps.autofix import selectors

    urls = {item.url.split("?")[0] for item in selectors.attention_items()}
    assert urls and all(url.startswith("/superadmin/") for url in urls)


# --- Production settings -----------------------------------------------------------------------

PATH_ENV = {
    "SUPERADMIN_PATH_PREFIX": PREFIX,
    "ALLOWED_HOSTS": "pitline.co.uk",
    "CSRF_TRUSTED_ORIGINS": "https://pitline.co.uk",
    "AUTOFIX_SUPERADMIN_URL": "https://pitline.co.uk/superadmin",
}


def test_production_path_mode_requires_the_proxy_secret():
    result = _check_prod("import django;django.setup()", **PATH_ENV, SUPERADMIN_PROXY_SECRET="short")
    assert result.returncode != 0 and "SUPERADMIN_PROXY_SECRET" in result.stderr


def test_production_path_mode_is_hardened():
    script = (
        "import django;django.setup();from django.conf import settings as s;"
        "assert s.FORCE_SCRIPT_NAME=='/superadmin' and s.STATIC_URL=='/superadmin/static/';"
        "assert s.SESSION_COOKIE_NAME=='__Secure-afsa_session' and s.CSRF_COOKIE_NAME=='__Secure-afsa_csrftoken';"
        "assert s.SESSION_COOKIE_PATH==s.CSRF_COOKIE_PATH=='/superadmin/';"
        "assert s.SESSION_COOKIE_SAMESITE==s.CSRF_COOKIE_SAMESITE=='Strict';"
        "assert s.AUTOFIX_STEP_UP and s.OTP_REQUIRED_FOR_ALL and not s.SECURE_HSTS_INCLUDE_SUBDOMAINS;"
        "print('ok')"
    )
    result = _check_prod(script, **PATH_ENV, SUPERADMIN_PROXY_SECRET="p" * 40)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_production_refuses_a_malformed_prefix():
    result = _check_prod(
        "import django;django.setup()", **{**PATH_ENV, "SUPERADMIN_PATH_PREFIX": "superadmin/../x"}
    )
    assert result.returncode != 0 and "SUPERADMIN_PATH_PREFIX" in result.stderr
