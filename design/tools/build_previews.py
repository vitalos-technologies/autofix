"""Rebuild design/preview/*.html from design/screens/*.dc.html.

Run from the repo root: python design/tools/build_previews.py
Screens come from the design canvas (https://claude.ai/artifact/UYRN7ayr8LpWS5U59221mP).
When the canvas changes, re-download the .dc.html files into design/screens/ and rerun.
"""
import glob
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
ACCENT = "#155fba"

for path in sorted(glob.glob(os.path.join(ROOT, "screens", "*.dc.html"))):
    src = open(path, encoding="utf-8").read()
    title = re.search(r"<title>(.*?)</title>", src).group(1)
    helmet = re.search(r"<helmet>(.*?)</helmet>", src, re.S).group(1)
    body = re.search(r"</helmet>(.*?)</x-dc>", src, re.S).group(1)
    width, height = re.search(r'"\$preview":\{"width":(\d+),"height":(\d+)\}', src).groups()
    body = body.replace("{{accent}}", ACCENT)
    body = re.sub(r'href="([A-Za-z0-9-]+)\.dc\.html"', r'href="\1.html"', body)
    page_style = "body{margin:0}" if int(width) > 500 else (
        "html{background:#d9dee5} body{display:flex;justify-content:center;padding:24px 0}")
    name = os.path.basename(path).replace(".dc.html", ".html")
    with open(os.path.join(ROOT, "preview", name), "w", encoding="utf-8") as out:
        out.write(f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Pitline design preview</title>
{helmet}
<style>{page_style}</style>
</head>
<body>
<!-- Static preview generated from design/screens/{os.path.basename(path)}. Garage accent shown as {ACCENT}. Frame {width}x{height}. -->
{body}
</body>
</html>
""")
    print("built", name)
