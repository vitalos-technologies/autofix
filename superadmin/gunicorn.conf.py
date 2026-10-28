"""Gunicorn settings. Tunable through environment variables on the container."""

import multiprocessing
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
workers = int(os.environ.get("WEB_CONCURRENCY", min(2 * multiprocessing.cpu_count() + 1, 4)))
threads = int(os.environ.get("GUNICORN_THREADS", "2"))
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "60"))
graceful_timeout = 30
keepalive = 5
max_requests = 1000
max_requests_jitter = 100
worker_tmp_dir = "/dev/shm"  # noqa: S108 - shared-memory heartbeat files, standard for containers
# The platform ingress is the only client; it sets X-Forwarded-For/Proto.
forwarded_allow_ips = os.environ.get("FORWARDED_ALLOW_IPS", "*")
# Django emits structured access logs with request IDs; gunicorn logs only errors.
accesslog = None
errorlog = "-"
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")
