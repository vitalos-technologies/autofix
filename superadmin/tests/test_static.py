"""Every static file a template or the stylesheet names exists (the manifest storage 500s otherwise)."""

import re
from pathlib import Path

import pytest
from django.contrib.staticfiles import finders

BASE = Path(__file__).resolve().parent.parent
REFERENCES = sorted(
    {
        match
        for template in (BASE / "templates").rglob("*.html")
        for match in re.findall(r"static '([^']+)'", template.read_text())
    }
)
FONTS = sorted(
    set(re.findall(r'url\("\.\./fonts/([^"]+)"\)', (BASE / "assets" / "tailwind.css").read_text()))
)


@pytest.mark.parametrize("path", REFERENCES)
def test_template_static_references_exist(path):
    if path == "css/app.css":
        pytest.skip("built by bin/tailwind.sh")
    assert finders.find(path), path


@pytest.mark.parametrize("font", FONTS)
def test_stylesheet_fonts_exist(font):
    assert (BASE / "static" / "fonts" / font).is_file()


def test_no_vitalos_platform_branding_left():
    for template in (BASE / "templates").rglob("*.html"):
        text = template.read_text()
        assert "Vitalos Super Admin" not in text, template
        assert "vitalos-wordmark" not in text, template
