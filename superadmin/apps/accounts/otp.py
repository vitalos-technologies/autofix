"""TOTP second-factor helpers."""

import base64

import qrcode
import qrcode.image.svg
from django.conf import settings
from django.utils.safestring import mark_safe
from django_otp.plugins.otp_totp.models import TOTPDevice

from .roles import is_superadmin


def confirmed_devices(user):
    return TOTPDevice.objects.filter(user=user, confirmed=True)


def otp_required(user) -> bool:
    if not user.is_authenticated:
        return False
    if getattr(settings, "OTP_REQUIRED_FOR_ALL", False):
        return True
    if settings.OTP_REQUIRED_FOR_SUPERADMIN and is_superadmin(user):
        return True
    return confirmed_devices(user).exists()


def pending_device(user) -> TOTPDevice:
    """The unconfirmed device being enrolled, created on first use."""
    device = TOTPDevice.objects.filter(user=user, confirmed=False).order_by("-id").first()
    if device is None:
        device = TOTPDevice.objects.create(user=user, name="Authenticator app", confirmed=False)
    return device


def base32_secret(device: TOTPDevice) -> str:
    return base64.b32encode(device.bin_key).decode().rstrip("=")


def qr_svg(device: TOTPDevice) -> str:
    image = qrcode.make(device.config_url, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    svg = image.to_string(encoding="unicode")
    # Generated locally from the device URL; contains no user-controlled markup.
    return mark_safe(svg)  # noqa: S308  # nosec B308 B703


def verify(user, token: str) -> TOTPDevice | None:
    token = "".join(ch for ch in (token or "") if ch.isdigit())
    if len(token) != 6:
        return None
    for device in confirmed_devices(user):
        allowed, _ = device.verify_is_allowed()
        if allowed and device.verify_token(token):
            return device
    return None
