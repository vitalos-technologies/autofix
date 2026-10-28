"""WSGI wrapper for path mode (DECISIONS D18): the app lives under one prefix, e.g. /superadmin."""

from .middleware import HEALTH_PATH


class PrefixMiddleware:
    """Move ``prefix`` from PATH_INFO to SCRIPT_NAME; anything outside it is a bare 404.

    Django then routes on the path below the prefix and builds every URL under it (FORCE_SCRIPT_NAME
    is the same prefix). /healthz/ stays reachable at the root for the platform's probes.
    """

    def __init__(self, app, prefix: str):
        self.app = app
        self.prefix = prefix.rstrip("/")

    def __call__(self, environ, start_response):
        if self.prefix:
            path = environ.get("PATH_INFO", "")
            if path == self.prefix or path.startswith(self.prefix + "/"):
                environ["SCRIPT_NAME"] = self.prefix
                environ["PATH_INFO"] = path[len(self.prefix) :] or "/"
            elif path != HEALTH_PATH:
                start_response(
                    "404 Not Found", [("Content-Type", "text/plain"), ("Cache-Control", "no-store")]
                )
                return [b"Not found"]
        return self.app(environ, start_response)
