"""Generates the QluePrint logo system as SVG. Usage: python -I docs/brand/build-logos.py <geist woff2> <out dir> <icon out>"""
import math
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

font_path, out_dir, icon_out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
out_dir.mkdir(parents=True, exist_ok=True)

BLUE = "#173f9e"      # blueprint paper
BLUE_DEEP = "#12347f"  # its grid's major lines sit on this
INK = "#111318"        # wordmark on light
PAPER = "#f5f7fb"      # wordmark on dark
WHITE = "#ffffff"


# ---------- the mark: Q as a blueprint, tail = connection, node = clue ----------
# The tail leaves the ring at 45°, drops, then turns along the grid to a node: an ER-diagram
# connector, routed like a blueprint line, so the Q never reads as a magnifying glass
DROP = 1.42   # how far below the centre the elbow turns, in ring radii
REACH = 1.42  # how far right the node sits, in ring radii


def mark(cx, cy, r, stroke, color, node_hole=None):
    """Ring + elbow tail ending in a node. node_hole: the colour punched in the node, or None for solid."""
    a = math.radians(45)
    sx, sy = cx + r * math.cos(a), cy + r * math.sin(a)
    ex, ey = cx + r * REACH, cy + r * DROP
    node_r = stroke * 1.0
    parts = [
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="none" stroke="{color}" stroke-width="{stroke:.1f}"/>',
        f'<path d="M{sx:.1f} {sy - stroke * 0.3:.1f} V{ey:.1f} H{ex:.1f}" fill="none" stroke="{color}" stroke-width="{stroke:.1f}" stroke-linejoin="round"/>',
        f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="{node_r:.1f}" fill="{color}"/>',
    ]
    if node_hole:
        parts.append(f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="{node_r * 0.42:.1f}" fill="{node_hole}"/>')
    return "\n  ".join(parts)


def mark_box(r, stroke):
    """The mark's extent around its ring centre: (left, top, right, bottom)."""
    out = r + stroke / 2
    return (-out, -out, r * REACH + stroke, r * DROP + stroke)


def tile(size, grid):
    """The macOS-grid tile: body 824/1024 of the canvas, blueprint paper with a drafting grid."""
    k = size / 1024
    x, w, rx = 100 * k, 824 * k, 185 * k
    out = [
        f'<rect x="{x:.1f}" y="{x:.1f}" width="{w:.1f}" height="{w:.1f}" rx="{rx:.1f}" fill="{BLUE}"/>',
    ]
    if grid:
        step = 824 * k / 12
        lines = []
        for i in range(1, 12):
            p = x + i * step
            major = i % 4 == 0
            op = 0.16 if major else 0.07
            lines.append(f'<path d="M{p:.1f} {x:.1f}V{x + w:.1f}M{x:.1f} {p:.1f}H{x + w:.1f}" stroke="{WHITE}" stroke-opacity="{op}" stroke-width="{1.5 * k * 1.4:.2f}"/>')
        out.append(f'<clipPath id="body"><rect x="{x:.1f}" y="{x:.1f}" width="{w:.1f}" height="{w:.1f}" rx="{rx:.1f}"/></clipPath>')
        out.append('<g clip-path="url(#body)">' + "".join(lines) + "</g>")
    out.append(f'<rect x="{x + 1:.1f}" y="{x + 1:.1f}" width="{w - 2:.1f}" height="{w - 2:.1f}" rx="{rx - 1:.1f}" fill="none" stroke="{WHITE}" stroke-opacity="0.12" stroke-width="{2 * k:.1f}"/>')
    return "\n  ".join(out)


def icon_body(grid=True, heavy=False):
    """The icon's markup on a 1024 canvas."""
    stroke = 92 if heavy else 76
    r = 172
    left, top, right, bottom = mark_box(r, stroke)
    cx = 512 - (left + right) / 2
    cy = 512 - (top + bottom) / 2
    return tile(1024, grid) + "\n  " + mark(cx, cy, r, stroke, WHITE, node_hole=BLUE)


def icon_svg(grid=True, heavy=False):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
        "  <!-- QluePrint app icon. A Q drawn as a blueprint: its tail is a connection, the node a clue -->\n  "
        + icon_body(grid, heavy)
        + "\n</svg>\n"
    )


# ---------- wordmark: the mark's Q, then "luePrint" in Geist SemiBold, outlined ----------
font = TTFont(font_path)
font = instantiateVariableFont(font, {"wght": 600})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font["head"].unitsPerEm
cap = font["OS/2"].sCapHeight
hmtx = font["hmtx"]


def word_paths(text, x0, baseline, scale, tracking):
    """Glyph outlines laid out left to right; returns (path data, advance end)."""
    d, x = [], x0
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        d.append(pen.getCommands())
        x += hmtx[name][0] * scale + tracking
    return " ".join(d), x


def wordmark(height, color, q_color):
    """The wordmark alone at cap height `height`; returns (svg body, width)."""
    scale = height / cap
    stem = 0.155 * height  # Geist SemiBold's stem at this cap height
    r = (height - stem) / 2
    cx = r + stem / 2
    q = mark(cx, height / 2, r, stem, q_color)
    # The rest starts just past the ring; the Q's connector runs under the "l", like a descender
    start = cx + r + stem * 1.2
    d, end = word_paths("luePrint", start, height, scale, -0.012 * height)
    return f'{q}\n  <path d="{d}" fill="{color}"/>', end


def horizontal(on_dark):
    """The icon tile, then the wordmark, centred on each other."""
    h = 112  # wordmark cap height
    size = 176  # tile size
    gap = 40
    color = PAPER if on_dark else INK
    body, width = wordmark(h, color, color)
    s_ = size / 824  # the tile body (824 of the 1024 canvas) fills `size`
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size + gap + width:.0f} {size}">\n'
        f"  <title>QluePrint</title>\n"
        f'  <g transform="translate({-100 * s_:.2f} {-100 * s_:.2f}) scale({s_:.5f})">\n  {icon_body()}\n  </g>\n'
        f'  <g transform="translate({size + gap} {(size - h) / 2:.1f})">\n  {body}\n  </g>\n</svg>\n'
    )


def mono(color):
    """One colour, no tile: the mark, then the wordmark."""
    h = 112
    r, stroke = 62, 26
    left, top, right, bottom = mark_box(r, stroke)
    cy = -top
    body, width = wordmark(h, color, color)
    total_h = bottom - top
    x0 = right - left + 44
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {x0 + width:.0f} {total_h:.0f}">\n'
        f"  <title>QluePrint</title>\n  {mark(-left, cy, r, stroke, color)}\n"
        f'  <g transform="translate({x0:.1f} {(total_h - h) / 2:.1f})">\n  {body}\n  </g>\n</svg>\n'
    )


icon = icon_svg()
icon_out.write_text(icon)
(out_dir / "qlueprint-icon.svg").write_text(icon)
(out_dir / "qlueprint-favicon.svg").write_text(icon_svg(grid=False, heavy=True))
(out_dir / "qlueprint-logo-light.svg").write_text(horizontal(on_dark=False))
(out_dir / "qlueprint-logo-dark.svg").write_text(horizontal(on_dark=True))
(out_dir / "qlueprint-logo-mono-black.svg").write_text(mono("#000000"))
(out_dir / "qlueprint-logo-mono-white.svg").write_text(mono("#ffffff"))
print("written", sorted(p.name for p in out_dir.iterdir()))
