# syntax=docker/dockerfile:1.7
# Autofix Super Admin: multi-stage build, gunicorn + WhiteNoise, non-root runtime.
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
# Optional: trust an extra CA during the build only (TLS-inspecting corporate proxies), e.g.
#   docker build --secret id=build_ca,src=/path/to/ca-bundle.pem .
# Secret mounts are never written into image layers.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.txt
COPY . .
# Build Tailwind CSS with the pinned, checksum-verified standalone CLI, then collect static files.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export CURL_CA_BUNDLE=/run/secrets/build_ca; fi; \
    sh bin/tailwind.sh \
    && rm -f bin/tailwindcss bin/.tailwind-version \
    && DJANGO_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(64))')" \
       DATABASE_URL=sqlite:////tmp/collectstatic.sqlite3 \
       ALLOWED_HOSTS=localhost CSRF_TRUSTED_ORIGINS=http://localhost \
       DJANGO_SETTINGS_MODULE=config.settings.prod \
       /opt/venv/bin/python manage.py collectstatic --noinput --verbosity 0

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/opt/venv/bin:$PATH \
    DJANGO_SETTINGS_MODULE=config.settings.prod \
    LOG_FORMAT=json \
    PORT=8000
# postgresql-client provides pg_dump for the scheduled backup job (bin/backup.sh).
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=app:app /app /app
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '8000')}/healthz/\", timeout=4)"]
CMD ["gunicorn", "config.wsgi:application", "--config", "gunicorn.conf.py"]
