"""Builds the Pitline logo SVGs and icon PNGs (DECISIONS D22, design/brand/pitline/README.md).

Stand-ins drawn from the written brand kit until the official vector files arrive. Run from the repo
root with fonttools, brotli, shapely and uharfbuzz installed and ImageMagick (`magick`) on PATH:

    python design/tools/build_brand.py

Writes design/brand/pitline/*.svg|png, public/brand/*, src/app/icon.svg and src/app/apple-icon.png,
and the super admin's superadmin/static/brand/* and superadmin/static/favicon.ico.
"""

import shutil
import subprocess
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
import uharfbuzz as hb
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "design" / "brand" / "pitline"
PUBLIC = ROOT / "public" / "brand"
SUPERADMIN = ROOT / "superadmin" / "static"
FONT = SUPERADMIN / "fonts" / "inter.woff2"

NAVY = "#0F2747"
BLUE = "#2563EB"
ORANGE = "#F97316"
WHITE = "#FFFFFF"

# --- The mark, on a 64-unit grid -------------------------------------------------------------------
# A bold rounded capital A; a wrench head (round eye with an open jaw) cut out of the right leg above
# the crossbar; a Signal Orange triangle in the lower counter.
LEG_HALF = 6.0
legs = LineString([(12, 54), (32, 10), (52, 54)]).buffer(LEG_HALF, cap_style="round", join_style="round", quad_segs=16)
crossbar = LineString([(20, 38), (44, 38)]).buffer(4.5, cap_style="round", quad_segs=16)
# An open-end wrench head seen flat: a round head with its jaw slot. The head is cut away and the slot
# stays solid, so the A shows a C-shaped gap; the jaw opens outward, square to the right leg.
HEAD = (41.6, 31.0)
head = Point(*HEAD).buffer(4.8, quad_segs=24)
jaw = affinity.rotate(box(HEAD[0], HEAD[1] - 1.7, HEAD[0] + 8, HEAD[1] + 1.7), -24.4, origin=HEAD)
letter = unary_union([legs, crossbar]).difference(head.difference(jaw))
triangle = Polygon([(25, 55.5), (39, 55.5), (32, 46.5)])


def ring_path(coords):
    points = [f"{x:.2f} {y:.2f}" for x, y in list(coords)[:-1]]
    return "M" + " L".join(points) + "Z"


def shape_path(geometry):
    polygons = getattr(geometry, "geoms", [geometry])
    parts = []
    for polygon in polygons:
        parts.append(ring_path(polygon.exterior.coords))
        parts.extend(ring_path(interior.coords) for interior in polygon.interiors)
    return "".join(parts)


LETTER_D = shape_path(letter)
TRIANGLE_D = shape_path(triangle)
MARK_BOUNDS = unary_union([letter, triangle]).bounds  # minx, miny, maxx, maxy

# --- The wordmark: "Pitline" in Inter ExtraBold, as outlines ----------------------------------------
def _font_bytes():
    # HarfBuzz needs the sfnt, not WOFF2.
    import io

    buffer = io.BytesIO()
    face = TTFont(FONT)
    face.flavor = None
    face.save(buffer)
    return buffer.getvalue()


FONT_BYTES = _font_bytes()


def inter(weight):
    face = TTFont(FONT)
    instantiateVariableFont(face, {"wght": weight}, inplace=True)
    return face


font = inter(800)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
UPM = font["head"].unitsPerEm
CAP = font["OS/2"].sCapHeight
TRACKING = -0.02 * UPM  # Inter Display-style tight setting for a logo


def text_path(text, size, weight=400, tracking=0.0):
    """(path d, width) for one line of Inter at `size` px, baseline at y=0, kerned by HarfBuzz."""
    face = inter(weight)
    face_glyphs, order = face.getGlyphSet(), face.getGlyphOrder()
    hb_font = hb.Font(hb.Face(FONT_BYTES))
    hb_font.set_variations({"wght": weight})
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    hb.shape(hb_font, buffer, {"kern": True, "liga": True})
    scale = size / face["head"].unitsPerEm
    pen = SVGPathPen(face_glyphs, ntos=lambda value: f"{value:.2f}")
    x = 0.0
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        face_glyphs[order[info.codepoint]].draw(TransformPen(pen, (scale, 0, 0, -scale, x + position.x_offset * scale, 0)))
        x += position.x_advance * scale + tracking * size
    return pen.getCommands(), x - tracking * size


def wordmark(cap_height):
    """(path d, width) for "Pitline" with its baseline at y=0 and capitals cap_height tall."""
    scale = cap_height / CAP
    pen = SVGPathPen(glyphs, ntos=lambda value: f"{value:.2f}")
    x = 0.0
    for character in "Pitline":
        name = cmap[ord(character)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        x += (glyphs[name].width + TRACKING) * scale
    return pen.getCommands(), x - TRACKING * scale


def mark_group(letter_fill, triangle_fill, dx=0.0, dy=0.0, scale=1.0):
    transform = f' transform="translate({dx:.2f} {dy:.2f}) scale({scale:g})"' if (dx or dy or scale != 1) else ""
    return (
        f"<g{transform}>"
        f'<path fill="{letter_fill}" fill-rule="evenodd" d="{LETTER_D}"/>'
        f'<path fill="{triangle_fill}" d="{TRIANGLE_D}"/>'
        "</g>"
    )


def svg(width, height, body, label="Pitline"):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.2f} {height:.2f}" '
        f'role="img" aria-label="{label}"><title>{label}</title>{body}</svg>\n'
    )


# Clear space is the kit's: at least the height of the A on every side. The files are trimmed to the
# artwork; layouts add the clear space around them.
MINX, MINY, MAXX, MAXY = MARK_BOUNDS
MARK_W, MARK_H = MAXX - MINX, MAXY - MINY


def icon_svg(letter_fill, triangle_fill):
    return svg(MARK_W, MARK_H, mark_group(letter_fill, triangle_fill, -MINX, -MINY))


def horizontal_layout():
    cap = MARK_H * 0.56
    word_d, word_w = wordmark(cap)
    gap = MARK_H * 0.28
    return {
        "width": MARK_W + gap + word_w, "height": MARK_H, "markX": -MINX, "markY": -MINY,
        "wordX": MARK_W + gap, "wordY": MARK_H / 2 + cap / 2, "word": word_d,
    }


def stacked_layout():
    cap = MARK_H * 0.42
    word_d, word_w = wordmark(cap)
    gap = MARK_H * 0.22
    width = max(word_w, MARK_W)
    return {
        "width": width, "height": MARK_H + gap + cap * 1.02, "markX": (width - MARK_W) / 2 - MINX, "markY": -MINY,
        "wordX": (width - word_w) / 2, "wordY": MARK_H + gap + cap, "word": word_d,
    }


LAYOUTS = {"horizontal": horizontal_layout(), "stacked": stacked_layout()}


def lockup_svg(layout, letter_fill, triangle_fill, word_fill):
    body = mark_group(letter_fill, triangle_fill, layout["markX"], layout["markY"])
    body += f'<path fill="{word_fill}" transform="translate({layout["wordX"]:.2f} {layout["wordY"]:.2f})" d="{layout["word"]}"/>'
    return svg(layout["width"], layout["height"], body)


def horizontal_svg(letter_fill, triangle_fill, word_fill):
    return lockup_svg(LAYOUTS["horizontal"], letter_fill, triangle_fill, word_fill)


def stacked_svg(letter_fill, triangle_fill, word_fill):
    return lockup_svg(LAYOUTS["stacked"], letter_fill, triangle_fill, word_fill)


def geometry_module():
    """src/components/brand/logo-geometry.ts: the same artwork for the inline React logo."""

    def number(value):
        return f"{value:.2f}".rstrip("0").rstrip(".")

    lines = [
        "// Generated by design/tools/build_brand.py from the Pitline brand kit (DECISIONS D22). Do not edit by hand.",
        "",
        "/** The mark (the A with its wrench cut-out, and the triangle), trimmed to its own box. */",
        "export const PITLINE_MARK = {",
        f"  width: {number(MARK_W)},",
        f"  height: {number(MARK_H)},",
        f"  x: {number(-MINX)},",
        f"  y: {number(-MINY)},",
        f'  letter: "{LETTER_D}",',
        f'  triangle: "{TRIANGLE_D}",',
        "} as const;",
        "",
        "/** Mark and wordmark side by side, or stacked. */",
        "export const PITLINE_LOCKUPS = {",
    ]
    for name, layout in LAYOUTS.items():
        fields = ", ".join(f"{key}: {number(layout[key])}" for key in ["width", "height", "markX", "markY", "wordX", "wordY"])
        lines.append(f'  {name}: {{ {fields}, word: "{layout["word"]}" }},')
    lines += ["} as const;", ""]
    return "\n".join(lines)


def app_icon_svg(background, letter_fill, triangle_fill, size=512):
    inner = size * 0.62
    scale = inner / MARK_H
    dx = (size - MARK_W * scale) / 2 - MINX * scale
    dy = (size - MARK_H * scale) / 2 - MINY * scale
    body = f'<rect width="{size}" height="{size}" rx="{size * 0.22:.0f}" fill="{background}"/>'
    body += mark_group(letter_fill, triangle_fill, dx, dy, scale)
    return svg(size, size, body)


def favicon_svg(size=32):
    # The colour mark on white, a little larger than the app icon's so it reads at 16px.
    inner = size * 0.84
    scale = inner / MARK_H
    dx = (size - MARK_W * scale) / 2 - MINX * scale
    dy = (size - MARK_H * scale) / 2 - MINY * scale
    body = f'<rect width="{size}" height="{size}" rx="{size * 0.18:.0f}" fill="{WHITE}"/>'
    body += mark_group(BLUE, ORANGE, dx, dy, scale)
    return svg(size, size, body)


def og_svg():
    """1200x630 social card: the primary logo, the tagline (with "fully booked." in Electric Blue over a
    short orange underline), the subline and the "Built for independent garages" line."""
    width, height, left = 1200, 630, 96
    layout = LAYOUTS["horizontal"]
    logo_scale = 64 / layout["height"]
    body = f'<rect width="{width}" height="{height}" fill="{WHITE}"/>'
    body += f'<rect y="{height - 14}" width="{width}" height="14" fill="{NAVY}"/>'
    body += f'<g transform="translate({left} 92) scale({logo_scale:.4f})">'
    body += mark_group(BLUE, ORANGE, layout["markX"], layout["markY"])
    body += f'<path fill="{NAVY}" transform="translate({layout["wordX"]:.2f} {layout["wordY"]:.2f})" d="{layout["word"]}"/></g>'
    first, first_w = text_path("Your garage, ", 84, 800, -0.02)
    second, _ = text_path("fully booked.", 84, 800, -0.02)
    body += f'<path fill="{NAVY}" transform="translate({left} 330)" d="{first}"/>'
    body += f'<path fill="{BLUE}" transform="translate({left + first_w:.2f} 330)" d="{second}"/>'
    body += f'<rect x="{left + first_w + 4:.2f}" y="366" width="120" height="10" rx="5" fill="{ORANGE}"/>'
    sub, _ = text_path("Online booking, reminders and AI front desk tools for independent garages.", 30, 400)
    body += f'<path fill="#64748B" transform="translate({left} 440)" d="{sub}"/>'
    line, _ = text_path("Built for independent garages.", 26, 600)
    body += f'<path fill="{NAVY}" transform="translate({left} 540)" d="{line}"/>'
    return svg(width, height, body, "Pitline. Your garage, fully booked.")


FILES = {
    "pitline-logo-primary.svg": horizontal_svg(BLUE, ORANGE, NAVY),
    "pitline-logo-stacked.svg": stacked_svg(BLUE, ORANGE, NAVY),
    "pitline-logo-mono.svg": horizontal_svg(NAVY, NAVY, NAVY),
    "pitline-logo-mono-stacked.svg": stacked_svg(NAVY, NAVY, NAVY),
    "pitline-logo-reversed.svg": horizontal_svg(WHITE, ORANGE, WHITE),
    "pitline-logo-reversed-stacked.svg": stacked_svg(WHITE, ORANGE, WHITE),
    "pitline-icon.svg": icon_svg(BLUE, ORANGE),
    "pitline-icon-mono.svg": icon_svg(NAVY, NAVY),
    "pitline-icon-reversed.svg": icon_svg(WHITE, ORANGE),
    "pitline-app-icon.svg": app_icon_svg(BLUE, WHITE, WHITE),
    "pitline-app-icon-dark.svg": app_icon_svg(NAVY, WHITE, ORANGE),
    "pitline-favicon.svg": favicon_svg(),
    "pitline-og.svg": og_svg(),
}

# PNGs: (source svg, output name, width). Emails need raster logos; icons need the usual sizes.
RASTERS = [
    ("pitline-app-icon.svg", "pitline-app-icon-192.png", 192),
    ("pitline-app-icon.svg", "pitline-app-icon-512.png", 512),
    ("pitline-app-icon.svg", "apple-touch-icon.png", 180),
    ("pitline-app-icon-dark.svg", "pitline-app-icon-dark-512.png", 512),
    ("pitline-favicon.svg", "favicon-32.png", 32),
    ("pitline-favicon.svg", "favicon-16.png", 16),
    ("pitline-logo-primary.svg", "pitline-logo-email.png", 360),
    ("pitline-logo-reversed.svg", "pitline-logo-reversed-email.png", 360),
    ("pitline-og.svg", "pitline-og.png", 1200),
]


def rasterise(source: Path, target: Path, width: int):
    # Small artwork is drawn on a ~60-unit grid, so it needs a high density; the 1200px card does not.
    density = "192" if width >= 1000 else "1200"
    subprocess.run(
        ["magick", "-background", "none", "-density", density, str(source), "-resize", f"{width}x", str(target)],
        check=True,
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for name, content in FILES.items():
        (OUT / name).write_text(content, encoding="utf-8", newline="\n")
        shutil.copyfile(OUT / name, PUBLIC / name)
    for source, name, width in RASTERS:
        rasterise(OUT / source, OUT / name, width)
        shutil.copyfile(OUT / name, PUBLIC / name)
    subprocess.run(
        ["magick", str(OUT / "favicon-16.png"), str(OUT / "favicon-32.png"), str(OUT / "favicon.ico")], check=True
    )

    (ROOT / "src" / "components" / "brand").mkdir(exist_ok=True)
    (ROOT / "src" / "components" / "brand" / "logo-geometry.ts").write_text(geometry_module(), encoding="utf-8", newline="\n")

    # Next.js metadata files: the favicon and the Apple touch icon.
    shutil.copyfile(OUT / "pitline-favicon.svg", ROOT / "src" / "app" / "icon.svg")
    shutil.copyfile(OUT / "apple-touch-icon.png", ROOT / "src" / "app" / "apple-icon.png")
    shutil.copyfile(OUT / "favicon.ico", ROOT / "src" / "app" / "favicon.ico")

    # The super admin serves its own static copies (reversed variants for its navy surfaces).
    brand = SUPERADMIN / "brand"
    for name in ["pitline-logo-reversed-stacked.svg", "pitline-icon-reversed.svg", "pitline-favicon.svg"]:
        shutil.copyfile(OUT / name, brand / name)
    shutil.copyfile(OUT / "apple-touch-icon.png", brand / "apple-touch-icon.png")
    shutil.copyfile(OUT / "favicon-32.png", brand / "favicon-32.png")
    shutil.copyfile(OUT / "favicon.ico", SUPERADMIN / "favicon.ico")


if __name__ == "__main__":
    main()
