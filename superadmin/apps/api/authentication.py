from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework import authentication, exceptions

from apps.accounts.models import ApiToken


class ApiTokenAuthentication(authentication.BaseAuthentication):
    """``Authorization: Bearer afsa_…`` (``Token afsa_…`` also accepted). Tokens are stored hashed."""

    keywords = ("bearer", "token")

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).decode("latin-1").split()
        if not header or header[0].lower() not in self.keywords:
            return None
        if len(header) != 2:
            raise exceptions.AuthenticationFailed("Invalid Authorization header.")
        raw_key = header[1]
        token = (
            ApiToken.objects.usable()
            .select_related("user")
            .filter(key_hash=ApiToken.hash_key(raw_key))
            .first()
        )
        if token is None or not token.user.is_active:
            raise exceptions.AuthenticationFailed("Invalid, expired or revoked token.")
        now = timezone.now()
        if token.last_used_at is None or (now - token.last_used_at).total_seconds() > 60:
            ApiToken.objects.filter(pk=token.pk).update(last_used_at=now)
        return token.user, token

    def authenticate_header(self, request):
        return 'Bearer realm="api"'


class ApiTokenScheme(OpenApiAuthenticationExtension):
    target_class = "apps.api.authentication.ApiTokenAuthentication"
    name = "ApiToken"

    def get_security_definition(self, auto_schema):
        return {
            "type": "http",
            "scheme": "bearer",
            "description": "Personal API token from Settings → API tokens.",
        }
