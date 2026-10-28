import json
import logging
import re
import subprocess
import sys
from pathlib import Path

from django.test import Client

from apps.core.logging import RequestIDFilter, request_id_var

BASE_DIR = Path(__file__).resolve().parent.parent


def test_strict_csp_with_nonce(superadmin, client_for):
    response = client_for(superadmin).get("/")
    policy = response["Content-Security-Policy"]
    nonce = re.search(r"'nonce-([^']+)'", policy).group(1)
    assert "default-src 'none'" in policy and "frame-ancestors 'none'" in policy
    assert "unsafe-inline" not in policy and "unsafe-eval" not in policy
    body = response.content.decode()
    # Every script tag carries the per-request nonce; there are no inline handlers.
    scripts = re.findall(r"<script[^>]*>", body)
    assert scripts and all(f'nonce="{nonce}"' in tag for tag in scripts)
    assert not re.search(r"\son[a-z]+=", body)
    assert ' style="' not in body


def test_security_headers(superadmin, client_for):
    response = client_for(superadmin).get("/")
    assert response["X-Frame-Options"] == "DENY"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["Referrer-Policy"] == "same-origin"
    assert "camera=()" in response["Permissions-Policy"]
    assert "no-store" in response["Cache-Control"] and "private" in response["Cache-Control"]


def test_request_id_is_generated_or_propagated(db):
    client = Client()
    generated = client.get("/login/")["X-Request-ID"]
    assert re.fullmatch(r"[0-9a-f]{32}", generated)
    assert client.get("/login/", HTTP_X_REQUEST_ID="abc-12345678")["X-Request-ID"] == "abc-12345678"
    # Unsafe values are replaced rather than echoed.
    assert client.get("/login/", HTTP_X_REQUEST_ID="<bad>")["X-Request-ID"] != "<bad>"


def test_health_check_bypasses_host_validation():
    response = Client().get("/healthz/", HTTP_HOST="10.0.0.12:8000")
    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_json_log_lines_include_request_id():
    from pythonjsonlogger.json import JsonFormatter

    record = logging.LogRecord("superadmin.access", logging.INFO, __file__, 1, "request", None, None)
    token = request_id_var.set("req-123456789")
    try:
        RequestIDFilter().filter(record)
    finally:
        request_id_var.reset(token)
    formatter = JsonFormatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s %(request_id)s", rename_fields={"levelname": "level"}
    )
    line = json.loads(formatter.format(record))
    assert line["request_id"] == "req-123456789" and line["level"] == "INFO"


def _prod_env(**overrides):
    env = {
        "PATH": "/usr/bin:/bin",
        "DJANGO_SETTINGS_MODULE": "config.settings.prod",
        "DJANGO_SECRET_KEY": "x" * 20 + "-not-a-real-secret-only-for-settings-tests-" + "y" * 20,
        "DATABASE_URL": "postgres://user@localhost:5432/db",
        "ALLOWED_HOSTS": "superadmin.autofix.vitalos.co.uk",
        "CSRF_TRUSTED_ORIGINS": "https://superadmin.autofix.vitalos.co.uk",
        # Explicit, so a developer's local .env cannot leak http URLs into this check.
        "AUTOFIX_APP_URL": "https://autofix.vitalos.co.uk",
        "AUTOFIX_SUPERADMIN_URL": "https://superadmin.autofix.vitalos.co.uk",
        "AUTOFIX_DATABASE_URL": "postgres://autofix_superadmin@db.example.test:5432/postgres",
        "AUTOFIX_STATUS_TOKEN": "",
    }
    env.update(overrides)
    return env


def _check_prod(script, **overrides):
    return subprocess.run(  # noqa: S603 - fixed interpreter and arguments
        [sys.executable, "-c", script],
        cwd=BASE_DIR,
        env=_prod_env(**overrides),
        capture_output=True,
        text=True,
        check=False,
    )


def test_production_settings_are_hardened():
    script = (
        "import django;django.setup();from django.conf import settings as s;"
        "assert not s.DEBUG;assert s.SECURE_SSL_REDIRECT;assert s.SESSION_COOKIE_SECURE and s.CSRF_COOKIE_SECURE;"
        "assert s.SECURE_HSTS_SECONDS>=31536000;assert s.SESSION_COOKIE_AGE==28800;"
        "assert s.ALLOWED_HOSTS==['superadmin.autofix.vitalos.co.uk'];assert s.SECURE_PROXY_SSL_HEADER;"
        "assert 'Manifest' in s.STORAGES['staticfiles']['BACKEND'];"
        "db=s.DATABASES['default'];assert db['CONN_MAX_AGE']==0 and db['CONN_HEALTH_CHECKS'];"
        "assert db['DISABLE_SERVER_SIDE_CURSORS'];print('ok')"
    )
    result = _check_prod(script)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_production_refuses_a_weak_secret_key():
    result = _check_prod("import django;django.setup()", DJANGO_SECRET_KEY="short")
    assert result.returncode != 0 and "DJANGO_SECRET_KEY" in result.stderr


def test_set_password_tokens_never_reach_the_access_log():
    from apps.core.middleware import loggable_path

    assert loggable_path("/account/set-password/MQ/dgcgj6-664337ad5168497bc2704decd4441ec7/") == (
        "/account/set-password/[redacted]/"
    )
    assert loggable_path("/garages/") == "/garages/"


def test_production_refuses_http_handoff_urls():
    result = _check_prod("import django;django.setup()", AUTOFIX_APP_URL="http://autofix.example.test")
    assert result.returncode != 0 and "AUTOFIX_APP_URL must be https" in result.stderr


def test_production_requires_the_least_privilege_role():
    result = _check_prod(
        "import django;django.setup()",
        AUTOFIX_DATABASE_URL="postgres://postgres@db.example.test:5432/postgres",
    )
    assert result.returncode != 0 and "autofix_superadmin" in result.stderr


def test_production_accepts_the_pooler_role_name_and_requires_tls():
    script = (
        "import django;django.setup();from django.conf import settings as s;"
        "a=s.DATABASES['autofix'];assert a['OPTIONS']['sslmode']=='require';"
        "assert 'default_transaction_read_only=on' in a['OPTIONS']['options'];print('ok')"
    )
    result = _check_prod(
        script, AUTOFIX_DATABASE_URL="postgres://autofix_superadmin.abcd@pooler.example.test:5432/postgres"
    )
    assert result.returncode == 0, result.stderr


def test_production_refuses_a_short_status_token():
    result = _check_prod("import django;django.setup()", AUTOFIX_STATUS_TOKEN="short")
    assert result.returncode != 0 and "AUTOFIX_STATUS_TOKEN" in result.stderr


def test_production_refuses_autofix_without_tls():
    result = _check_prod(
        "import django;django.setup()",
        AUTOFIX_DATABASE_URL="postgres://autofix_superadmin@db.example.test:5432/postgres?sslmode=disable",
    )
    assert result.returncode != 0 and "must use TLS" in result.stderr
