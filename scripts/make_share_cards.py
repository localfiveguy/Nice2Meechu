"""Generate Nice2Meechu share cards for Instagram / Facebook.

Outputs to /app/share_cards/:
  - story_minimal_1080x1920.png       (Instagram/Facebook Story)
  - feed_square_1080x1080.png         (Instagram/Facebook Feed)
  - story_qr_1080x1920.png            (Story with big QR code for in-person sharing)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import qrcode

OUT = Path("/app/share_cards")
OUT.mkdir(exist_ok=True)

BLACK = (8, 8, 10)
WHITE = (255, 255, 255)
RED = (255, 77, 77)        # the "2" in the wordmark
CYAN = (0, 229, 255)       # the trailing dot
DIM = (255, 255, 255, 90)

FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
URL = "https://nice2meechu.com"


def font(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size=size)


def text_w(draw, s, f):
    """Width of `s` rendered with font `f`."""
    l, t, r, b = draw.textbbox((0, 0), s, font=f)
    return r - l


def grain(img):
    """Adds subtle film grain on top — gives the black background depth."""
    import random
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = overlay.load()
    rng = random.Random(42)
    for _ in range(int(w * h * 0.012)):
        x, y = rng.randint(0, w - 1), rng.randint(0, h - 1)
        a = rng.randint(8, 22)
        px[x, y] = (255, 255, 255, a)
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def soft_glow(size, color, radius):
    """Returns a soft radial glow PNG."""
    w, h = size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((0, 0, w, h), fill=color + (255,))
    return layer.filter(ImageFilter.GaussianBlur(radius))


def wordmark(draw, x, y, size, layout="stacked"):
    """Renders the Nice2Meechu wordmark with brand-colored 2 and dot.
    layout='stacked' draws on two lines (Nice2 / Meechu.), 'inline' on one.
    Returns (right_edge, bottom_edge)."""
    f = font(size, bold=True)
    if layout == "stacked":
        # Line 1: Nice + 2 (red)
        draw.text((x, y), "Nice", font=f, fill=WHITE)
        line1_w = text_w(draw, "Nice", f)
        draw.text((x + line1_w, y), "2", font=f, fill=RED)
        line1_total = line1_w + text_w(draw, "2", f)
        # Line 2: Meechu + . (cyan) — tight line height
        line_h = int(size * 0.95)
        draw.text((x, y + line_h), "Meechu", font=f, fill=WHITE)
        line2_w = text_w(draw, "Meechu", f)
        draw.text((x + line2_w, y + line_h), ".", font=f, fill=CYAN)
        return x + max(line1_total, line2_w + text_w(draw, ".", f)), y + line_h * 2
    else:
        s_pre, s_two, s_mid, s_dot = "Nice", "2", "Meechu", "."
        cx = x
        for s, c in [(s_pre, WHITE), (s_two, RED), (s_mid, WHITE), (s_dot, CYAN)]:
            draw.text((cx, y), s, font=f, fill=c)
            cx += text_w(draw, s, f)
        return cx, y + int(size * 0.95)


# ---------------------------------------------------------------------------
# Card 1 — INSTAGRAM / FACEBOOK STORY (1080x1920) — minimal/typographic
# ---------------------------------------------------------------------------
def card_story_minimal():
    W, H = 1080, 1920
    img = Image.new("RGB", (W, H), BLACK)
    # Two big soft glows in brand colors, blurred way out — adds depth
    img.paste(soft_glow((900, 900), RED, 220), (-200, -180), soft_glow((900, 900), RED, 220))
    img.paste(soft_glow((900, 900), CYAN, 220), (380, 1240), soft_glow((900, 900), CYAN, 220))
    img = grain(img)
    draw = ImageDraw.Draw(img)

    # Tiny top label
    f_small = font(34, bold=True)
    draw.text((80, 110), "HYPERLOCAL · VIDEO-FIRST", font=f_small, fill=(255, 255, 255, 200))

    # Stacked wordmark — left aligned, takes most of the upper third
    wordmark(draw, 80, 220, size=230, layout="stacked")

    # Tagline (3-line stack for rhythm)
    f_tag = font(64, bold=True)
    draw.text((80, 920), "Anonymous", font=f_tag, fill=WHITE)
    draw.text((80, 1000), "until the", font=f_tag, fill=WHITE)
    draw.text((80, 1080), "spark.", font=f_tag, fill=CYAN)

    # Bottom URL pill
    pill_y = H - 240
    pill_h = 110
    pill_w = 720
    pill_x = (W - pill_w) // 2
    draw.rounded_rectangle(
        (pill_x, pill_y, pill_x + pill_w, pill_y + pill_h),
        radius=pill_h // 2,
        fill=WHITE,
    )
    f_url = font(46, bold=True)
    url_w = text_w(draw, URL, f_url)
    draw.text((pill_x + (pill_w - url_w) // 2, pill_y + 28), URL, font=f_url, fill=BLACK)

    # Footnote
    f_foot = font(28, bold=True)
    foot = "JOIN THE FEED · TAP THE LINK"
    foot_w = text_w(draw, foot, f_foot)
    draw.text(((W - foot_w) // 2, H - 90), foot, font=f_foot, fill=(255, 255, 255, 140))

    img.save(OUT / "story_minimal_1080x1920.png", "PNG", optimize=True)
    print("✓ story_minimal_1080x1920.png")


# ---------------------------------------------------------------------------
# Card 2 — INSTAGRAM / FACEBOOK FEED SQUARE (1080x1080)
# ---------------------------------------------------------------------------
def card_feed_square():
    W, H = 1080, 1080
    img = Image.new("RGB", (W, H), BLACK)
    img.paste(soft_glow((700, 700), RED, 180), (-120, -120), soft_glow((700, 700), RED, 180))
    img.paste(soft_glow((600, 600), CYAN, 180), (650, 650), soft_glow((600, 600), CYAN, 180))
    img = grain(img)
    draw = ImageDraw.Draw(img)

    # Top label
    f_label = font(28, bold=True)
    draw.text((70, 80), "MEET YOUR CITY", font=f_label, fill=(255, 255, 255, 200))

    # Wordmark inline-friendly, but stacked still looks better on a square
    wordmark(draw, 70, 140, size=180, layout="stacked")

    # Tagline single line
    f_tag = font(44, bold=True)
    draw.text((70, 590), "Hyperlocal. Video-first.", font=f_tag, fill=WHITE)
    draw.text((70, 650), "Anonymous until the ", font=f_tag, fill=WHITE)
    tail_x = 70 + text_w(draw, "Anonymous until the ", f_tag)
    draw.text((tail_x, 650), "spark.", font=f_tag, fill=CYAN)

    # URL pill
    pill_h = 86
    pill_w = 540
    pill_x = 70
    pill_y = H - 200
    draw.rounded_rectangle(
        (pill_x, pill_y, pill_x + pill_w, pill_y + pill_h),
        radius=pill_h // 2,
        fill=WHITE,
    )
    f_url = font(38, bold=True)
    url_w = text_w(draw, URL, f_url)
    draw.text((pill_x + (pill_w - url_w) // 2, pill_y + 22), URL, font=f_url, fill=BLACK)

    # Right-side decorative dot stack (the brand cyan dot, scaled big)
    for i, r in enumerate([14, 22, 34]):
        cx = W - 130 - i * 90
        cy = H - 155
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=CYAN if i == 0 else (255, 255, 255, 90))

    img.save(OUT / "feed_square_1080x1080.png", "PNG", optimize=True)
    print("✓ feed_square_1080x1080.png")


# ---------------------------------------------------------------------------
# Card 3 — STORY WITH BIG QR (1080x1920) — for in-person/bar/coffee shop sharing
# ---------------------------------------------------------------------------
def card_story_qr():
    W, H = 1080, 1920
    img = Image.new("RGB", (W, H), BLACK)
    img.paste(soft_glow((1000, 1000), CYAN, 240), (-150, 1100), soft_glow((1000, 1000), CYAN, 240))
    img.paste(soft_glow((800, 800), RED, 200), (450, -100), soft_glow((800, 800), RED, 200))
    img = grain(img)
    draw = ImageDraw.Draw(img)

    # Wordmark
    wx, wy = wordmark(draw, 80, 140, size=180, layout="stacked")

    # Tagline
    f_tag = font(48, bold=True)
    draw.text((80, 600), "Point. Scan. Meechu.", font=f_tag, fill=WHITE)

    # QR code — high error correction so the centered logo doesn't break scans
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=24,
        border=2,
    )
    qr.add_data(URL)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    # Resize to fit ~760px
    qr_size = 760
    qr_img = qr_img.resize((qr_size, qr_size), Image.LANCZOS)
    # White card behind the QR with padding + rounded corners
    pad = 60
    card_w = qr_size + pad * 2
    card_h = qr_size + pad * 2
    card_x = (W - card_w) // 2
    card_y = 760
    card_layer = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card_layer)
    cd.rounded_rectangle((0, 0, card_w, card_h), radius=48, fill=WHITE)
    img.paste(card_layer, (card_x, card_y), card_layer)
    img.paste(qr_img, (card_x + pad, card_y + pad))

    # Center the "n2m" cyan-dot mark on top of the QR (H-level ECC tolerates ~30% occlusion)
    mark_d = 140
    mx = card_x + (card_w - mark_d) // 2
    my = card_y + (card_h - mark_d) // 2
    draw.ellipse((mx, my, mx + mark_d, my + mark_d), fill=BLACK)
    f_mark = font(54, bold=True)
    mark_text = "n2m"
    mark_w = text_w(draw, mark_text, f_mark)
    draw.text((mx + (mark_d - mark_w) // 2, my + 38), mark_text, font=f_mark, fill=WHITE)
    # Cyan dot accent on the mark
    draw.ellipse((mx + mark_d - 30, my + mark_d - 30, mx + mark_d - 10, my + mark_d - 10), fill=CYAN)

    # Footer text under the QR
    f_url = font(40, bold=True)
    url_w = text_w(draw, URL, f_url)
    draw.text(((W - url_w) // 2, card_y + card_h + 60), URL, font=f_url, fill=WHITE)
    f_foot = font(26, bold=True)
    foot = "HYPERLOCAL · VIDEO-FIRST · ANONYMOUS UNTIL THE SPARK"
    foot_w = text_w(draw, foot, f_foot)
    draw.text(((W - foot_w) // 2, card_y + card_h + 130), foot, font=f_foot, fill=(255, 255, 255, 150))

    img.save(OUT / "story_qr_1080x1920.png", "PNG", optimize=True)
    print("✓ story_qr_1080x1920.png")


if __name__ == "__main__":
    card_story_minimal()
    card_feed_square()
    card_story_qr()
    print(f"\nAll cards saved to: {OUT}")
