"""Accessibility check: axe-core (WCAG 2.2 AA tags) over the Super Admin pages, light and dark, 1440 and 390.

Fails (exit 1) on any serious or critical violation. Used by CI against the production image and
runnable locally against `manage.py runserver`.

    python e2e/a11y.py --base http://localhost:8000 --axe path/to/axe.min.js \
        --session <session key of a signed-in, second-factor-verified SuperAdmin>

Garage pages use the first garage on the Garages page. The page CSP blocks injected scripts, so the
browser context bypasses CSP for axe only.
"""

import argparse
import re
import sys

from playwright.sync_api import sync_playwright

PAGES = [
    "/login/",
    "/",
    "/garages/",
    "/signups/",
    "/domains/",
    "/messaging/",
    "/jobs/",
    "/activity/",
    "/audit/",
    "/audit/autofix/",
    "/team/",
    "/notifications/",
    "/notifications/attention/",
    "/settings/users/",
    "/settings/tokens/",
    "/notifications/preferences/",
    "/account/",
    "/help/",
    "/system/health/",
]
GARAGE_TABS = ["overview", "team", "bookings", "domains", "messaging", "plan", "agreements", "audit"]
VIEWPORTS = {"1440": {"width": 1440, "height": 900}, "390": {"width": 390, "height": 844}}
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]


def garage_pages(page, base: str) -> list[str]:
    page.goto(base + "/garages/")
    link = page.locator("#garage-results tbody a").first
    href = link.get_attribute("href") if link.count() else None
    if not href or not re.fullmatch(r"/garages/[0-9a-f-]{36}/", href):
        return []
    return [f"{href}?tab={tab}" for tab in GARAGE_TABS] + [f"{href}view-as-support/"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--axe", required=True, help="Path to axe.min.js (axe-core)")
    parser.add_argument("--session", required=True, help="afsa_session cookie value")
    parser.add_argument("--chromium", default=None, help="Chromium executable (optional)")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**({"executable_path": args.chromium} if args.chromium else {}))
        for scheme, (width, viewport) in [(s, v) for s in ("light", "dark") for v in VIEWPORTS.items()]:
            context = browser.new_context(viewport=viewport, color_scheme=scheme, bypass_csp=True)
            page = context.new_page()
            context.add_cookies([{"name": "afsa_session", "value": args.session, "url": base}])
            extra = garage_pages(page, base)
            label = f"{scheme}/{width}"
            for path in PAGES + extra:
                context.clear_cookies()
                if path != "/login/":
                    context.add_cookies([{"name": "afsa_session", "value": args.session, "url": base}])
                response = page.goto(base + path)
                page.wait_for_load_state("networkidle")
                if response is None or response.status >= 400:
                    print(f"FAIL {label:10} {path}: HTTP {response.status if response else 'no response'}")
                    failures += 1
                    continue
                page.add_script_tag(path=args.axe)
                result = page.evaluate(
                    "async (tags) => await axe.run(document, {runOnly: {type: 'tag', values: tags}})", TAGS
                )
                serious = [v for v in result["violations"] if v["impact"] in ("serious", "critical")]
                print(
                    f"{'FAIL' if serious else 'ok  '} {label:10} {path} ({len(result['violations'])} issue(s))"
                )
                for violation in result["violations"]:
                    targets = [", ".join(node["target"]) for node in violation["nodes"][:3]]
                    print(
                        f"     [{violation['impact']}] {violation['id']}: {violation['help']} e.g. {targets}"
                    )
                failures += len(serious)
            context.close()
        browser.close()
    print(f"Serious or critical accessibility violations: {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
