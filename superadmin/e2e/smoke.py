"""End-to-end smoke test for a running Autofix Super Admin (local container or a deployed one).

Usage (credentials come only from the environment and are never printed):

    SMOKE_BASE_URL=http://localhost:8000 \
    SMOKE_EMAIL=<bootstrap admin email> \
    SMOKE_PASSWORD=... \
    python e2e/smoke.py --screenshots docs/screenshots

Behind the Autofix proxy (path mode, e.g. SMOKE_BASE_URL=http://localhost:8000/superadmin), set
SMOKE_PROXY_SECRET to the container's SUPERADMIN_PROXY_SECRET; the browser then sends it as the proxy
would. If the account has no authenticator yet, the test enrols a temporary TOTP device and removes it at the
end. If a device already exists, pass its base32 secret in SMOKE_TOTP_SECRET. The test changes nothing
in Autofix: it opens every page at 1440 and 390 pixels wide, the garage tabs, the command palette and
the live search, and checks the browser console for CSP violations. With SMOKE_STATUS_TOKEN it also
calls the product status endpoint. Screenshots are named <page>-1440.png and <page>-390.png.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import traceback
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import Page, sync_playwright

PAGES = [
    ("overview", "/", "Overview"),
    ("garages", "/garages/", "Garages"),
    ("signups", "/signups/", "Sign-ups and onboarding"),
    ("domains", "/domains/", "Domains"),
    ("messaging", "/messaging/", "Messaging"),
    ("calls", "/calls/", "Calls"),
    ("jobs", "/jobs/", "Jobs"),
    ("activity", "/activity/", "Activity"),
    ("audit", "/audit/", "Audit"),
    ("audit-autofix", "/audit/autofix/", "Audit"),
    ("notifications", "/notifications/", "Notifications"),
    ("team", "/team/", "Team"),
    ("health", "/system/health/", "System health"),
    ("settings-users", "/settings/users/", "Settings"),
    ("settings-tokens", "/settings/tokens/", "Settings"),
    ("settings-notifications", "/notifications/preferences/", "Settings"),
    ("account", "/account/", None),
    ("help", "/help/", "Help"),
    ("api-docs", "/api/docs/", None),
    ("enquiries", "/enquiries/", "Enquiries"),
]
TABS = ["overview", "team", "bookings", "domains", "messaging", "calls", "plan", "agreements", "audit"]
WIDTHS = {"1440": {"width": 1440, "height": 900}, "390": {"width": 390, "height": 844}}


def totp(secret: str, at: float | None = None) -> str:
    """RFC 6238 TOTP (SHA-1, 30 s, 6 digits) without third-party dependencies."""
    padded = secret.upper() + "=" * (-len(secret) % 8)
    key = base64.b32decode(padded)
    counter = int((at or time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{code % 1_000_000:06d}"


PROXY_HEADER = "x-autofix-superadmin-proxy"


class Smoke:
    def __init__(self, page: Page, base: str, shots: Path | None):
        self.page = page
        self.base = base.rstrip("/") + "/"
        self.shots = shots
        self.results: list[dict] = []
        self.enrolled_secret: str | None = None

    def url(self, path: str) -> str:
        return urljoin(self.base, path.lstrip("/"))

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append({"check": name, "ok": bool(ok), "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}", flush=True)
        if not ok:
            raise AssertionError(name)

    def shot(self, name: str) -> None:
        if self.shots:
            self.shots.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(self.shots / f"{name}.png"), full_page=True)

    def both_widths(self, name: str) -> None:
        for label, size in WIDTHS.items():
            self.page.set_viewport_size(size)
            if self.shots:
                # Reload so the layout is laid out for this width (the sidebar padding animates).
                self.page.reload()
                self.page.wait_for_load_state("networkidle")
            self.shot(f"{name}-{label}")
        self.page.set_viewport_size(WIDTHS["1440"])

    def login(self, email: str, password: str) -> None:
        response = self.page.goto(self.url("/login/"))
        self.check("login page returns 200", response is not None and response.status == 200)
        self.both_widths("01-sign-in")
        self.page.get_by_label("Email").fill(email)
        self.page.get_by_label("Password").fill(password)
        self.page.get_by_role("button", name="Sign in").click()
        self.page.wait_for_load_state("networkidle")
        if "/account/2fa/setup/" in self.page.url:
            secret = self.page.get_by_test_id("totp-secret").inner_text().strip()
            self.both_widths("02-totp-enrolment")
            self.page.get_by_label("6-digit code").fill(totp(secret))  # submits itself on the sixth digit
            self.page.wait_for_url(lambda url: "/account/2fa/setup/" not in url)
            self.enrolled_secret = secret
        elif "/login/verify/" in self.page.url:
            secret = os.environ.get("SMOKE_TOTP_SECRET", "")
            self.check("TOTP secret supplied for an enrolled account", bool(secret))
            self.page.get_by_label("6-digit code").fill(totp(secret))
            self.page.wait_for_url(lambda url: "/login/verify/" not in url)
        self.page.wait_for_load_state("networkidle")
        self.check(
            "signed in and on the overview", self.page.url.rstrip("/") == self.base.rstrip("/"), self.page.url
        )

    def pages(self) -> None:
        for index, (name, path, heading) in enumerate(PAGES, start=3):
            response = self.page.goto(self.url(path))
            self.check(f"{path} returns 200", response is not None and response.status == 200)
            if heading:
                self.check(
                    f"{path} shows its heading",
                    self.page.get_by_role("heading", name=heading, level=1).count() > 0,
                )
            self.both_widths(f"{index:02d}-{name}")

    def garage(self) -> None:
        self.page.goto(self.url("/garages/"))
        link = self.page.locator("#garage-results tbody a").first
        self.check("garages list has at least one garage", link.count() > 0)
        link.click()
        self.page.wait_for_load_state("networkidle")
        self.check("garage detail opens", "/garages/" in self.page.url)
        detail_url = self.page.url.split("?")[0]
        for index, tab in enumerate(TABS, start=40):
            self.page.locator(f'[data-tab="{tab}"]').click()
            self.page.wait_for_selector(f'[data-testid="tab-{tab}"], [data-testid="tab-error"]')
            self.check(
                f"garage tab {tab} loads", self.page.locator(f'[data-testid="tab-{tab}"]').count() == 1
            )
            self.page.goto(f"{detail_url}?tab={tab}")
            self.both_widths(f"{index:02d}-garage-{tab}")
        self.page.goto(detail_url)
        button = self.page.get_by_test_id("view-as-support")
        if button.count():
            button.click()
            self.page.wait_for_selector('[data-testid="view-as-support-form"]')
            self.check("View as support asks for a reason first", True)
            self.page.goto(f"{detail_url}view-as-support/")
            self.both_widths("50-view-as-support")

    def palette_and_search(self) -> None:
        self.page.goto(self.url("/"))
        self.page.keyboard.press("Control+k")
        self.page.wait_for_selector("#palette[open]")
        self.page.locator("[data-palette-input]").fill("garages")
        self.page.wait_for_load_state("networkidle")
        self.check(
            "command palette finds the Garages page",
            self.page.locator("#palette-list").inner_text().find("Garages") >= 0,
        )
        self.shot("51-palette-1440")
        self.page.keyboard.press("Escape")
        search = self.page.locator("#global-search")
        search.fill("a")
        search.fill("ga")
        self.page.wait_for_selector('[data-testid="search-results"]')
        self.check("live search answers", True)

    def status_endpoint(self) -> None:
        token = os.environ.get("SMOKE_STATUS_TOKEN", "")
        if not token:
            return
        headers = {"Authorization": f"Bearer {token}"}
        if os.environ.get("SMOKE_PROXY_SECRET"):
            headers[PROXY_HEADER] = os.environ["SMOKE_PROXY_SECRET"]
        request = urllib.request.Request(  # noqa: S310 - the base URL is the operator's own
            self.url("/api/platform/v1/status"), headers=headers
        )
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310  # nosec B310
            body = json.loads(response.read())
        self.check("status endpoint answers for product autofix", body.get("product") == "autofix")

    def cleanup(self, password: str) -> None:
        if not self.enrolled_secret:
            return
        self.page.goto(self.url("/account/"))
        self.page.get_by_text("Replace authenticator").click()
        self.page.get_by_label("Current password").fill(password)
        self.page.get_by_role("button", name="Remove authenticator and sign out").click()
        self.page.wait_for_load_state("networkidle")
        self.check("temporary smoke-test authenticator removed", "/login/" in self.page.url)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", type=Path, default=None)
    parser.add_argument("--keep", action="store_true", help="Keep the temporary TOTP device.")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    base = os.environ.get("SMOKE_BASE_URL", "http://localhost:8000")
    email = os.environ["SMOKE_EMAIL"]
    password = os.environ["SMOKE_PASSWORD"]
    executable = os.environ.get("SMOKE_CHROMIUM")
    with sync_playwright() as playwright:
        launch = {"headless": not args.headed}
        if executable:
            launch["executable_path"] = executable
        browser = playwright.chromium.launch(**launch)
        proxy_secret = os.environ.get("SMOKE_PROXY_SECRET", "")
        context = browser.new_context(
            viewport=WIDTHS["1440"],
            color_scheme="light",
            extra_http_headers={PROXY_HEADER: proxy_secret} if proxy_secret else None,
        )
        page = context.new_page()
        console_errors: list[str] = []
        page.on(
            "console",
            lambda msg: console_errors.append(f"{page.url}: {msg.text}") if msg.type == "error" else None,
        )
        smoke = Smoke(page, base, args.screenshots)
        try:
            smoke.login(email, password)
            smoke.pages()
            smoke.garage()
            smoke.palette_and_search()
            smoke.status_endpoint()
            csp = [error for error in console_errors if "Content Security Policy" in error]
            smoke.check("no CSP violations in the browser console", not csp, "; ".join(csp)[:300])
            if not args.keep:
                smoke.cleanup(password)
        except Exception as exc:  # noqa: BLE001 - report and exit non-zero
            traceback.print_exc()
            try:
                smoke.shot("zz-failure")
            except Exception as shot_error:  # noqa: BLE001 - best effort
                print(f"Could not capture failure screenshot: {shot_error}", file=sys.stderr)
            print(f"Smoke test failed at {page.url}: {exc}", file=sys.stderr)
            return 1
        finally:
            if args.screenshots:
                args.screenshots.mkdir(parents=True, exist_ok=True)
                (args.screenshots / "smoke-results.json").write_text(
                    json.dumps({"base_url": base, "checks": smoke.results}, indent=2)
                )
            browser.close()
    print(f"All {len(smoke.results)} smoke checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
