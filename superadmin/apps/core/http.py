"""HTTP helpers shared across apps."""

from django.conf import settings


def client_ip(request, *args, **kwargs) -> str:
    """Resolve the client IP, trusting X-Forwarded-For only for the configured proxy hops."""
    remote_addr = request.META.get("REMOTE_ADDR", "")
    proxies = getattr(settings, "TRUSTED_PROXY_COUNT", 0)
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if proxies > 0 and forwarded:
        hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
        if len(hops) >= proxies:
            return hops[-proxies]
    return remote_addr
