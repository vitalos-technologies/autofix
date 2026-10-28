"""Presentation helpers: inline SVG icons, sparklines, colour swatches and badge styles.

Everything is rendered server-side as inline SVG so the strict CSP needs no inline styles or scripts.
"""

from decimal import Decimal

from django import template
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

register = template.Library()

_ICON_SHAPES = {
    "compass": '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    "code": '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/>',
    "sparkles": '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15v4M17 17h4"/>',
    "pen": '<path d="M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3"/>',
    "shield": '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    "flask": '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9"/>',
    "layers": '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
    "bell": '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "edit": '<path d="M4 20l4-1L19 8l-3-3L5 16l-1 4z"/>',
    "archive": '<path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4"/>',
    "refresh": '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    "restore": '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
    "up": '<path d="M6 15l6-6 6 6"/>',
    "down": '<path d="M6 9l6 6 6-6"/>',
    "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    "users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    "logout": '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    "activity": '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    "menu": '<path d="M4 6h16M4 12h16M4 18h16"/>',
    "x": '<path d="M6 6l12 12M18 6L6 18"/>',
    "check": '<path d="M5 12l5 5 9-10"/>',
    "download": '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    "upload": '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
    "key": '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
    "tree": '<path d="M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a2 2 0 0 0 2 2h5"/>',
    "alert": '<path d="M12 3l10 18H2zM12 10v4M12 17h.01"/>',
    "trend": '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
    "briefcase": '<path d="M3 7h18v13H3zM8 7V4h8v3M3 12h18"/>',
    "book": '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6M20 4v14h-6"/>',
    "api": '<path d="M7 8l-4 4 4 4M17 8l4 4-4 4M14 4l-4 16"/>',
    # Lucide (ISC licence) shapes for the sidebar and pages.
    "layout-dashboard": '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/>'
    '<rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    "inbox": '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6'
    'l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    "network": '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/>'
    '<rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
    "life-buoy": '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/>'
    '<path d="m4.93 4.93 4.24 4.24M14.83 9.17l4.24-4.24M14.83 14.83l4.24 4.24M9.17 14.83l-4.24 4.24"/>',
    "sun-moon": '<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/>'
    '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
    "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    "heart-pulse": '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'
    '<path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
    "panel-left": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    "command": '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    "mail": '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    "clock": '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    "paperclip": '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57'
    'a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    "reply": '<path d="M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4"/>',
    "note": '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
    "ban": '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    "globe": '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
    "image": '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/>'
    '<path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    "chat": '<path d="M4 4h16v12H10l-6 4z"/>',
    "send": '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
    "more": '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    "package": '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8'
    'a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    "external-link": '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    # Lucide "wrench" (ISC licence), the Autofix mark.
    "wrench": '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "copy": '<rect width="13" height="13" x="9" y="9" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
}
# Static, trusted SVG markup defined above; never built from user input.
ICONS = {name: mark_safe(shape) for name, shape in _ICON_SHAPES.items()}  # noqa: S308  # nosec B308 B703


def _hex(colour, default="currentColor"):
    valid = isinstance(colour, str) and len(colour) == 7 and colour.startswith("#")
    return colour if valid and all(ch in "0123456789abcdefABCDEF" for ch in colour[1:]) else default


@register.simple_tag
def icon(name, classes="h-5 w-5", colour=None):
    shapes = ICONS.get(name, ICONS["layers"])
    return format_html(
        '<svg class="{}" viewBox="0 0 24 24" fill="none" stroke="{}" stroke-width="1.75" '
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{}</svg>',
        classes,
        _hex(colour),
        shapes,
    )


@register.simple_tag
def swatch(colour, classes="h-3 w-3"):
    """Colour dot drawn with an SVG fill attribute (CSP blocks inline style attributes)."""
    return format_html(
        '<svg class="{}" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="{}"/></svg>',
        classes,
        _hex(colour, "#1446A5"),
    )


@register.simple_tag
def accent_bar(colour, classes="h-1.5 w-full"):
    return format_html(
        '<svg class="{}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">'
        '<rect width="100" height="4" fill="{}"/></svg>',
        classes,
        _hex(colour, "#1446A5"),
    )


@register.simple_tag
def sparkline(values, target=None, classes="h-10 w-full", width=120, height=36):
    """Inline SVG trend line over ``values`` (oldest first) with an optional dashed target line."""
    numbers = [Decimal(str(v.value if hasattr(v, "value") else v)) for v in values or []]
    if not numbers:
        return format_html('<span class="text-xs text-slate-400">{}</span>', "No data yet")
    scale = list(numbers) + ([Decimal(str(target))] if target is not None else [])
    low, high = min(scale), max(scale)
    span = (high - low) or Decimal(1)
    pad = 3

    def y(value):
        return float(height - pad - (Decimal(value) - low) / span * (height - 2 * pad))

    step = (width - 2 * pad) / max(len(numbers) - 1, 1)
    points = [(pad + index * step, y(value)) for index, value in enumerate(numbers)]
    if len(points) == 1:
        points.append((width - pad, points[0][1]))
    polyline = " ".join(f"{px:.1f},{py:.1f}" for px, py in points)
    target_line = ""
    if target is not None:
        ty = f"{y(target):.1f}"
        target_line = format_html(
            '<line x1="0" x2="{}" y1="{}" y2="{}" stroke="currentColor" stroke-opacity="0.35" '
            'stroke-dasharray="3 3" stroke-width="1"/>',
            width,
            ty,
            ty,
        )
    last_x, last_y = points[-1] if len(numbers) > 1 else points[0]
    return format_html(
        '<svg class="{}" viewBox="0 0 {} {}" preserveAspectRatio="none" role="img" aria-label="Trend of {} values">'
        '{}<polyline points="{}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" '
        'stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
        '<circle cx="{}" cy="{}" r="2.5" fill="currentColor"/></svg>',
        classes,
        width,
        height,
        len(numbers),
        target_line,
        polyline,
        f"{last_x:.1f}",
        f"{last_y:.1f}",
    )


_BADGE = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset "
_STYLES = {
    "slate": "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600",
    "green": "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800",
    "amber": "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
    "red": "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800",
    "blue": "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950 dark:text-cobalt-300 dark:ring-blue-800",
    "sky": "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
    "violet": "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-800",
}
_TONES = {
    # garage status
    "onboarding": "sky",
    "active": "green",
    "suspended": "amber",
    "cancelled": "red",
    # plans
    "trial": "amber",
    "essentials": "blue",
    "pro": "violet",
    # domain verification
    "pending_dns": "amber",
    "verifying": "sky",
    "failed": "red",
    # jobs and messages
    "queued": "slate",
    "running": "sky",
    "done": "green",
    "sending": "sky",
    "sent": "sky",
    "delivered": "green",
    "received": "slate",
    "skipped": "amber",
    "scheduled": "slate",
    # bookings
    "requested": "amber",
    "confirmed": "green",
    "collected": "blue",
    "no_show": "red",
    # alerts
    "critical": "red",
    "warning": "amber",
}


@register.filter
def badge_class(value):
    return _BADGE + _STYLES[_TONES.get(str(value), "slate")]


@register.simple_tag
def badges(values, classes=""):
    return format_html_join(
        "", '<span class="{} {}">{}</span>', ((badge_class(value), classes, value) for value in values or [])
    )


@register.filter
def delta(current, previous):
    """Signed change between two KPI values, or empty."""
    if current is None or previous is None:
        return ""
    change = current.value - previous.value
    return f"+{change}" if change > 0 else f"{change}"


@register.filter
def dictget(mapping, key):
    return (mapping or {}).get(key, 0)


@register.filter
def initials(user_or_email) -> str:
    """Two-letter avatar initials from a user (full name, else email) or an email address."""
    text = (
        getattr(user_or_email, "full_name", "")
        or getattr(user_or_email, "email", "")
        or str(user_or_email or "")
    )
    words = text.split("@")[0].replace(".", " ").replace("_", " ").split()
    return "".join(word[0] for word in words[:2]).upper() or "?"


@register.filter
def duration(delta) -> str:
    """'3 h 20 min' for a timedelta; empty for None."""
    if delta is None:
        return ""
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{max(minutes, 0)} min"
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f"{hours} h {minutes} min" if minutes else f"{hours} h"
    return f"{hours // 24} days"


@register.filter
def split_pairs(value: str) -> list[tuple[str, str]]:
    """ "7:7 days,30:30 days" -> [("7", "7 days"), ("30", "30 days")] for small static option lists."""
    return [tuple(part.split(":", 1)) for part in str(value).split(",") if ":" in part]


@register.filter
def pct_step(value) -> int:
    """A 0-100 width rounded to the nearest 5, matching the ``w-pct-N`` classes (no inline styles)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return int(max(0, min(100, round(number / 5) * 5)))


@register.filter
def plan_name(value) -> str:
    """A garages.plan value, old or D17, as the plan's name ("front_desk" -> "Pro")."""
    from apps.autofix.plans import LABELS, TRIAL, canonical

    if value == TRIAL:
        return "Pro (trial)"
    return LABELS.get(canonical(value), str(value or "").replace("_", " ").capitalize())
