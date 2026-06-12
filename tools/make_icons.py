# Генерирует иконки приложения: синий скруглённый квадрат с символом шекеля.
from PIL import Image, ImageDraw, ImageFont

SIZES = [180, 192, 512]
BG = (29, 78, 216)        # --accent #1d4ed8
FG = (255, 255, 255)

def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size // 5
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    font = ImageFont.truetype("arialbd.ttf", int(size * 0.62))
    ch = "₪"  # ₪
    box = d.textbbox((0, 0), ch, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), ch, font=font, fill=FG)
    return img

if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        make(s).save(os.path.join(out, f"icon-{s}.png"))
        print(f"icon-{s}.png")
