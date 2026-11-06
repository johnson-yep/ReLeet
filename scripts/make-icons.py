"""Makes icons/icon16.png, icon32.png, icon48.png and icon128.png from the
1024x1024 source icon (art/releet-icon-1024.png).

    python3 scripts/make-icons.py      # needs Pillow: pip install pillow

The source's rounded square is uneven (it was drawn by an image generator), so
this draws a clean one in the same colour and lays the source's white symbol
on it. At 16 px the source's calendar grid blurs into stripes, so that size is
drawn from simple shapes instead: the same ring and arrowhead, and a calendar
reduced to a frame. The toolbar sizes fill their whole canvas; 128 px keeps
the Chrome Web Store's 16 px margin.
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'art' / 'releet-icon-1024.png'
INDIGO = (84, 74, 214)
CORNER = 0.22  # corner radius, as a share of the square's side
# Output size → how much of the canvas the square fills.
SIZES = {32: 1.0, 48: 0.92, 128: 0.75}
SS = 8  # supersampling for smooth edges


def symbol_mask(source):
    """The white symbol as an alpha mask, from how far each pixel is from indigo toward white."""
    src = source.convert('RGBA')
    box = src.getbbox()
    mask = Image.new('L', src.size, 0)
    sp, mp = src.load(), mask.load()
    base = sum(INDIGO) / 3
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            r, g, b, a = sp[x, y]
            if a < 200:
                continue
            t = (min(r, g, b) - INDIGO[0]) / (255 - INDIGO[0])  # the indigo's darkest channel is red
            if r > 150 and g > 150:  # whitish, not the blue background
                mp[x, y] = max(0, min(255, round(255 * max(t, (sum((r, g, b)) / 3 - base) / (255 - base)))))
    return mask.crop(box)


def render(size, fill, symbol):
    big = size * SS
    side = round(big * fill)
    offset = (big - side) // 2
    canvas = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).rounded_rectangle(
        [offset, offset, offset + side - 1, offset + side - 1], radius=round(side * CORNER), fill=INDIGO + (255,)
    )
    white = Image.new('RGBA', (side, side), (255, 255, 255, 255))
    canvas.paste(white, (offset, offset), symbol.resize((side, side), Image.LANCZOS))
    return canvas.resize((size, size), Image.LANCZOS)


def simplified_16():
    u = 16  # drawing units per output pixel
    size = 16 * u
    white = (255, 255, 255, 255)
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=round(size * CORNER), fill=INDIGO + (255,))
    # The ring, open on the right between -20 and 28 degrees (0 = east, clockwise).
    center, radius, ring = size / 2, 6.0 * u, 1.6 * u
    draw.arc([center - radius, center - radius, center + radius, center + radius], start=28, end=340, fill=white, width=round(ring))
    # The arrowhead where the ring ends, pointing clockwise into the gap.
    angle = math.radians(-20)
    ex, ey = center + (radius - ring / 2) * math.cos(angle), center + (radius - ring / 2) * math.sin(angle)
    tangent = angle + math.pi / 2
    length, half_width = 2.6 * u, 2.4 * u
    nx, ny = math.cos(angle), math.sin(angle)
    back = (ex - 0.35 * length * math.cos(tangent), ey - 0.35 * length * math.sin(tangent))
    draw.polygon(
        [
            (ex + 0.75 * length * math.cos(tangent), ey + 0.75 * length * math.sin(tangent)),
            (back[0] + half_width * nx, back[1] + half_width * ny),
            (back[0] - half_width * nx, back[1] - half_width * ny),
        ],
        fill=white,
    )
    # The calendar: a white frame around an indigo window.
    width, height = 6.2 * u, 5.4 * u
    x0, y0 = center - width / 2, center - height / 2 + 0.3 * u
    draw.rounded_rectangle([x0, y0, x0 + width, y0 + height], radius=u, fill=white)
    draw.rectangle([x0 + u, y0 + 1.9 * u, x0 + width - u, y0 + height - u], fill=INDIGO + (255,))
    return image.resize((16, 16), Image.LANCZOS)


def main():
    out = ROOT / 'icons' / 'icon16.png'
    simplified_16().save(out, optimize=True)
    print(out.relative_to(ROOT))
    symbol = symbol_mask(Image.open(SOURCE))
    for size, fill in SIZES.items():
        out = ROOT / 'icons' / f'icon{size}.png'
        render(size, fill, symbol).save(out, optimize=True)
        print(out.relative_to(ROOT))


if __name__ == '__main__':
    main()
