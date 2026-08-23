import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets" / "ui"

CREAM = (241, 226, 188, 255)
PAPER_LIGHT = (249, 239, 211, 255)
INK = (25, 17, 36, 255)
INK_SOFT = (56, 38, 62, 255)
VELVET = (104, 10, 34, 255)
VELVET_DARK = (54, 5, 24, 255)
BRASS = (210, 151, 55, 255)
BRASS_LIGHT = (242, 199, 91, 255)
CYAN = (78, 225, 224, 255)
CYAN_DARK = (23, 113, 126, 255)
DISABLED = (112, 103, 105, 255)


def paper(size, seed):
    image = Image.new("RGBA", size, CREAM)
    pixels = image.load()
    randomizer = random.Random(seed)
    for _ in range(size[0] * size[1] // 34):
        x = randomizer.randrange(size[0])
        y = randomizer.randrange(size[1])
        shift = randomizer.choice((-8, -5, 4, 7))
        base = pixels[x, y]
        pixels[x, y] = tuple(
            max(0, min(255, channel + shift)) for channel in base[:3]
        ) + (255,)
    return image


def double_border(draw, size, outer, inner, radius=22):
    width, height = size
    draw.rounded_rectangle(
        (10, 10, width - 11, height - 11), radius=radius, outline=outer, width=7
    )
    draw.rounded_rectangle(
        (24, 24, width - 25, height - 25),
        radius=max(4, radius - 8),
        outline=inner,
        width=3,
    )


def corner_flourishes(draw, size, color):
    width, height = size
    corners = (
        (38, 38, 1, 1),
        (width - 38, 38, -1, 1),
        (38, height - 38, 1, -1),
        (width - 38, height - 38, -1, -1),
    )
    for x, y, sx, sy in corners:
        draw.arc(
            (x - 18, y - 18, x + 18, y + 18),
            180 if sx > 0 else 270,
            270 if sx > 0 else 360,
            fill=color,
            width=4,
        )
        draw.line((x, y, x + sx * 34, y), fill=color, width=4)
        draw.line((x, y, x, y + sy * 24), fill=color, width=4)


def make_panel():
    image = paper((512, 512), 11)
    draw = ImageDraw.Draw(image)
    double_border(draw, image.size, INK, BRASS)
    corner_flourishes(draw, image.size, INK_SOFT)
    for y in range(74, 462, 46):
        draw.line((62, y, 450, y), fill=(72, 52, 62, 24), width=1)
    return image


def make_card(selected=False):
    image = paper((512, 256), 21 if not selected else 22)
    draw = ImageDraw.Draw(image)
    border = CYAN_DARK if selected else INK
    double_border(draw, image.size, border, CYAN if selected else BRASS, radius=18)
    draw.polygon(
        ((44, 128), (62, 110), (80, 128), (62, 146)), fill=CYAN if selected else BRASS
    )
    draw.polygon(
        ((468, 128), (450, 110), (432, 128), (450, 146)),
        fill=CYAN if selected else BRASS,
    )
    if selected:
        draw.rectangle((34, 34, 45, 221), fill=CYAN)
    return image


def make_button(kind):
    colors = {
        "primary": (VELVET, BRASS_LIGHT, CREAM),
        "secondary": (INK_SOFT, BRASS, CREAM),
        "disabled": (DISABLED, (152, 140, 135, 255), (205, 194, 177, 255)),
    }
    fill, border, accent = colors[kind]
    image = Image.new("RGBA", (512, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (12, 18, 499, 237), radius=20, fill=fill, outline=border, width=7
    )
    draw.rounded_rectangle((27, 33, 484, 222), radius=13, outline=accent, width=2)
    draw.line((66, 128, 172, 128), fill=accent, width=3)
    draw.line((340, 128, 446, 128), fill=accent, width=3)
    draw.polygon(((185, 128), (200, 113), (215, 128), (200, 143)), fill=border)
    draw.polygon(((327, 128), (312, 113), (297, 128), (312, 143)), fill=border)
    return image


def make_marquee():
    image = Image.new("RGBA", (512, 256), VELVET_DARK)
    draw = ImageDraw.Draw(image)
    double_border(draw, image.size, BRASS, BRASS_LIGHT, radius=16)
    for x in range(48, 465, 52):
        for y in (46, 210):
            draw.ellipse(
                (x - 9, y - 9, x + 9, y + 9), fill=CYAN, outline=PAPER_LIGHT, width=2
            )
    for y in (88, 128, 168):
        draw.line((62, y, 450, y), fill=(78, 225, 224, 34), width=1)
    return image


def make_stamp():
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse(
        (48, 48, 464, 464), fill=(241, 226, 188, 236), outline=CYAN_DARK, width=20
    )
    draw.ellipse((82, 82, 430, 430), outline=INK, width=8)
    draw.ellipse((114, 114, 398, 398), outline=BRASS, width=4)
    points = []
    for index in range(20):
        radius = 108 if index % 2 == 0 else 48
        angle = -math.pi / 2 + index * math.pi / 10
        points.append((256 + math.cos(angle) * radius, 256 + math.sin(angle) * radius))
    draw.polygon(points, fill=CYAN_DARK, outline=INK)
    draw.ellipse((221, 221, 291, 291), fill=PAPER_LIGHT, outline=INK, width=5)
    return image


def make_ribbon():
    image = Image.new("RGBA", (512, 256), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.polygon(
        ((10, 54), (118, 54), (118, 202), (10, 202), (52, 128)), fill=VELVET_DARK
    )
    draw.polygon(
        ((502, 54), (394, 54), (394, 202), (502, 202), (460, 128)), fill=VELVET_DARK
    )
    draw.rounded_rectangle(
        (78, 32, 434, 224), radius=16, fill=VELVET, outline=BRASS_LIGHT, width=7
    )
    draw.line((112, 72, 400, 72), fill=CREAM, width=2)
    draw.line((112, 184, 400, 184), fill=CREAM, width=2)
    return image


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob("*.png"):
        stale.unlink()

    textures = {
        "panel.png": make_panel(),
        "card.png": make_card(),
        "card_selected.png": make_card(selected=True),
        "button_primary.png": make_button("primary"),
        "button_secondary.png": make_button("secondary"),
        "button_disabled.png": make_button("disabled"),
        "marquee.png": make_marquee(),
        "stamp.png": make_stamp(),
        "ribbon.png": make_ribbon(),
    }
    for filename, image in textures.items():
        image.save(OUTPUT / filename, format="PNG", optimize=True)

    manifest = {
        "generator": "tools/ui/build_textures.py",
        "textures": [
            {
                "file": filename,
                "width": image.width,
                "height": image.height,
                "bytes": (OUTPUT / filename).stat().st_size,
            }
            for filename, image in textures.items()
        ],
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8"
    )
    print(
        json.dumps(
            {
                "textures": len(textures),
                "bytes": sum(item["bytes"] for item in manifest["textures"]),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
