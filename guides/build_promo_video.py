#!/usr/bin/env python3
"""Build professional rashadtech.tv customer promo videos (EN + AR)."""
from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output"
FRAMES = OUT / "promo-frames"

W, H = 1920, 1080
FPS = 30
FADE = 0.35

RED = (229, 9, 20)
RED_HEX = "#E50914"
RED_GLOW = (255, 45, 55)
GOLD = (245, 197, 24)
WHITE = (255, 255, 255)
MUTED = (168, 168, 184)
DIM = (90, 90, 110)
GLASS = (255, 255, 255, 14)
GLASS_BORDER = (255, 255, 255, 38)
GREEN = (62, 207, 110)

FONT_EN = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
FONT_EN_BOLD = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
FONT_AR = "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf"
FONT_AR_BOLD = "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf"

BRAND_COLORS = {
    "Netflix": (229, 9, 20),
    "Shahid": (0, 180, 90),
    "Disney+": (17, 60, 207),
    "OSN+": (255, 140, 0),
    "Spotify": (30, 215, 96),
    "Games": (120, 80, 255),
    "نتفليكس": (229, 9, 20),
    "شاهد": (0, 180, 90),
    "ديزني+": (17, 60, 207),
    "سبوتيفاي": (30, 215, 96),
    "ألعاب": (120, 80, 255),
    "ببجي والمزيد": (120, 80, 255),
}

CONTENT = {
    "en": [
        {
            "type": "hero",
            "kicker": "PREMIUM STREAMING STORE",
            "title": "rashadtech",
            "suffix": ".tv",
            "subtitle": "One wallet · Every platform · Instant delivery",
            "badges": ["Netflix", "Shahid", "Disney+", "OSN+", "Spotify", "Games"],
        },
        {
            "type": "split",
            "headline": "Why customers switch to us",
            "left_title": "The old way",
            "left_items": ["Random sellers", "Hours of waiting", "Lost logins", "No real support"],
            "right_title": "rashadtech.tv",
            "right_items": ["One trusted store", "Telegram in seconds", "Private secure link", "Live support 24/7"],
        },
        {
            "type": "advantage",
            "num": "01",
            "title": "Instant Telegram delivery",
            "body": "Purchase once. Credentials, private link, and activation tools arrive in seconds — not hours.",
            "visual": "telegram",
        },
        {
            "type": "advantage",
            "num": "02",
            "title": "Smart wallet, one tap buy",
            "body": "Top up your balance once. Buy anytime with a single tap. Full transaction history in your account.",
            "visual": "wallet",
        },
        {
            "type": "advantage",
            "num": "03",
            "title": "Your private subscription hub",
            "body": "One encrypted link for logins, Netflix codes, TV activation, and Shahid reset — always ready.",
            "visual": "link",
        },
        {
            "type": "products",
            "title": "Every platform. One store.",
            "products": [
                ("N", "Netflix"),
                ("S", "Shahid VIP"),
                ("D", "Disney+"),
                ("O", "OSN+"),
                ("♪", "Spotify"),
                ("G", "PUBG & more"),
            ],
        },
        {
            "type": "steps",
            "title": "Live in 3 steps",
            "steps": [
                ("01", "Create account", "Under 60 seconds"),
                ("02", "Top up wallet", "Secure balance"),
                ("03", "Buy & stream", "Delivered on Telegram"),
            ],
        },
        {
            "type": "cta",
            "title": "Start streaming today",
            "url": "rashadtech.tv",
            "lines": ["WhatsApp  +961 79 306 701", "Telegram  @Rashadtech", "Bot  @Rashadtech_bot"],
        },
        {
            "type": "outro",
            "title": "Created by RashadTech",
            "subtitle": "Professional streaming subscriptions",
        },
    ],
    "ar": [
        {
            "type": "hero",
            "kicker": "متجر اشتراكات مميز",
            "title": "rashadtech",
            "suffix": ".tv",
            "subtitle": "محفظة واحدة · كل المنصات · توصيل فوري",
            "badges": ["نتفليكس", "شاهد", "ديزني+", "OSN+", "سبوتيفاي", "ألعاب"],
        },
        {
            "type": "split",
            "headline": "لماذا يختارنا العملاء",
            "left_title": "الطريقة القديمة",
            "left_items": ["بائعون عشوائيون", "ساعات انتظار", "بيانات ضائعة", "بدون دعم حقيقي"],
            "right_title": "rashadtech.tv",
            "right_items": ["متجر موثوق واحد", "تيليغرام خلال ثوانٍ", "رابط خاص آمن", "دعم مباشر"],
        },
        {
            "type": "advantage",
            "num": "01",
            "title": "توصيل فوري على تيليغرام",
            "body": "اشترِ مرة واحدة. البيانات والرابط الخاص وأدوات التفعيل تصل خلال ثوانٍ — ليس ساعات.",
            "visual": "telegram",
        },
        {
            "type": "advantage",
            "num": "02",
            "title": "محفظة ذكية وشراء بلمسة",
            "body": "عبّئ رصيدك مرة واحدة. اشترِ في أي وقت بلمسة. سجل كامل لكل معاملة في حسابك.",
            "visual": "wallet",
        },
        {
            "type": "advantage",
            "num": "03",
            "title": "مركز اشتراكك الخاص",
            "body": "رابط مشفر واحد للبيانات وأكواد نتفليكس وتفعيل التلفزيون وإعادة تعيين شاهد.",
            "visual": "link",
        },
        {
            "type": "products",
            "title": "كل المنصات. متجر واحد.",
            "products": [
                ("N", "نتفليكس"),
                ("ش", "شاهد VIP"),
                ("D", "ديزني+"),
                ("O", "OSN+"),
                ("♪", "سبوتيفاي"),
                ("G", "ببجي والمزيد"),
            ],
        },
        {
            "type": "steps",
            "title": "ابدأ بثلاث خطوات",
            "steps": [
                ("01", "أنشئ حسابك", "أقل من دقيقة"),
                ("02", "عبّئ المحفظة", "رصيد آمن"),
                ("03", "اشترِ واستمتع", "يوصل على تيليغرام"),
            ],
        },
        {
            "type": "cta",
            "title": "ابدأ المشاهدة اليوم",
            "url": "rashadtech.tv",
            "lines": ["واتساب  +961 79 306 701", "تيليغرام  @Rashadtech", "البوت  @Rashadtech_bot"],
        },
        {
            "type": "outro",
            "title": "من إنشاء RashadTech",
            "subtitle": "اشتراكات بث احترافية",
        },
    ],
}

DURATIONS = {
    "hero": 4.5,
    "split": 4.5,
    "advantage": 4.0,
    "products": 4.5,
    "steps": 4.5,
    "cta": 4.5,
    "outro": 5.0,
}


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def ease_out_back(t: float) -> float:
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def clamp(t: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, t))


def blend(bg: tuple[int, int, int], fg: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = clamp(t)
    return tuple(int(bg[i] + (fg[i] - bg[i]) * t) for i in range(3))


BG_RGB = (5, 5, 8)


def stagger(progress: float, index: int, step: float = 0.12) -> float:
    return ease_out_cubic(clamp((progress - index * step) / 0.55))


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    words = text.split()
    lines, current = [], ""
    for word in words:
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def draw_cinematic_bg(progress: float = 0.0) -> Image.Image:
    img = Image.new("RGB", (W, H), (5, 5, 8))
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / max(H - 1, 1)
        r = int(5 + 12 * t)
        g = int(5 + 12 * t)
        b = int(10 + 18 * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))

    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    drift = progress * 40
    orbs = [
        (W * 0.82 + drift, H * 0.18, 420, (*RED, 48)),
        (W * 0.12 - drift * 0.5, H * 0.75, 360, (79, 142, 247, 36)),
        (W * 0.5, H * 0.45 + drift * 0.3, 280, (245, 197, 24, 18)),
    ]
    for cx, cy, radius, color in orbs:
        od.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color)

  # subtle grid
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 80):
        gd.line([(x, 0), (x, H)], fill=(255, 255, 255, 6))
    for y in range(0, H, 80):
        gd.line([(0, y), (W, y)], fill=(255, 255, 255, 6))
    overlay = Image.alpha_composite(overlay, grid)

    # vignette
    vig = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vig)
    vd.ellipse((-W * 0.15, -H * 0.1, W * 1.15, H * 1.2), fill=(0, 0, 0, 110))
    overlay = Image.alpha_composite(overlay, vig)

    result = Image.alpha_composite(img.convert("RGBA"), overlay)
    return result.convert("RGB")


def glass_panel(base: Image.Image, box: tuple[int, int, int, int], radius: int = 24) -> Image.Image:
    x1, y1, x2, y2 = box
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle(box, radius=radius, fill=GLASS, outline=GLASS_BORDER, width=1)
    highlight = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    hd.rounded_rectangle((x1, y1, x2, y1 + 2), radius=radius, fill=(255, 255, 255, 30))
    combined = Image.alpha_composite(base.convert("RGBA"), panel)
    combined = Image.alpha_composite(combined, highlight)
    return combined.convert("RGB")


def draw_text_rtl(draw, x, y, text, font, fill, rtl, max_width=None):
    if rtl and max_width:
        tw = draw.textlength(text, font=font)
        draw.text((x + max_width - tw, y), text, fill=fill, font=font)
    else:
        draw.text((x, y), text, fill=fill, font=font)


def draw_wrapped(draw, text, x, y, max_width, font, fill, rtl, gap=10):
    for line in wrap_text(draw, text, font, max_width):
        draw_text_rtl(draw, x, y, line, font, fill, rtl, max_width)
        y += font.size + gap
    return y


def draw_brand_mark(draw, cx, cy, size, alpha=255):
    if size < 8:
        return
    r = size
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(*RED, alpha), width=4)
    inner = size * 0.55
    draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=(*RED, min(alpha, 200)))
    tf = load_font(FONT_EN_BOLD, int(size * 0.9))
    label = "R"
    tw = draw.textlength(label, font=tf)
    draw.text((cx - tw / 2, cy - size * 0.42), label, fill=(*WHITE, alpha), font=tf)


def draw_top_bar(img: Image.Image, rtl: bool, progress: float) -> Image.Image:
    base = img.convert("RGBA")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    alpha = int(220 * ease_out_cubic(clamp(progress / 0.3)))
    draw.rectangle((0, 0, W, 72), fill=(0, 0, 0, alpha))
    draw.line([(0, 72), (W, 72)], fill=(*RED, min(alpha, 180)), width=2)
    ff = load_font(FONT_EN_BOLD, 20)
    brand = "RASHADTECH"
    tw = draw.textlength(brand, font=ff)
    x = W - margin - tw if rtl else margin
    draw.text((x, 24), brand, fill=(*RED_GLOW, alpha), font=ff)
    dot_x = x - 18 if rtl else x + tw + 18
    draw.ellipse((dot_x - 5, 29, dot_x + 5, 39), fill=(*GREEN, alpha))
    return Image.alpha_composite(base, overlay).convert("RGB")


margin = 100


def render_phone_mock(draw, x, y, w, h, visual: str, progress: float):
    draw.rounded_rectangle((x, y, x + w, y + h), radius=36, fill=(12, 12, 18), outline=(255, 255, 255, 50), width=2)
    draw.rounded_rectangle((x + 16, y + 48, x + w - 16, y + h - 24), radius=20, fill=(20, 20, 30))
    notch_w = 80
    draw.rounded_rectangle((x + w // 2 - notch_w // 2, y + 14, x + w // 2 + notch_w // 2, y + 30), radius=8, fill=(8, 8, 12))

    inner_x, inner_y = x + 36, y + 72
    inner_w = w - 72
    if visual == "telegram":
        draw.rounded_rectangle((inner_x, inner_y, inner_x + inner_w, inner_y + 120), radius=14, fill=(34, 158, 217, 180))
        tf = load_font(FONT_EN_BOLD, 22)
        draw.text((inner_x + 20, inner_y + 18), "RashadTech Bot", fill=WHITE, font=tf)
        bf = load_font(FONT_EN, 18)
        lines = ["✓ Netflix Premium — delivered", "Email: user@mail.com", "Password: ••••••••", "Link: rashadtech.tv?t=…"]
        ly = inner_y + 52
        for i, line in enumerate(lines):
            a = stagger(progress, i + 1, 0.08)
            draw.text((inner_x + 20, ly), line, fill=blend(BG_RGB, MUTED, a), font=bf)
            ly += 28
    elif visual == "wallet":
        draw.rounded_rectangle((inner_x, inner_y, inner_x + inner_w, inner_y + 160), radius=16, fill=(30, 30, 45))
        wf = load_font(FONT_EN_BOLD, 42)
        draw.text((inner_x + 24, inner_y + 24), "$42.00", fill=blend(BG_RGB, GOLD, stagger(progress, 0)), font=wf)
        draw.text((inner_x + 24, inner_y + 82), "Wallet balance", fill=MUTED, font=load_font(FONT_EN, 18))
        buy_p = stagger(progress, 2)
        draw.rounded_rectangle((inner_x, inner_y + 190, inner_x + inner_w, inner_y + 250), radius=12, fill=blend(BG_RGB, RED, buy_p))
        draw.text((inner_x + 24, inner_y + 208), "Buy Netflix — $8.99", fill=WHITE, font=load_font(FONT_EN_BOLD, 20))
    else:
        draw.rounded_rectangle((inner_x, inner_y, inner_x + inner_w, inner_y + 200), radius=16, fill=(25, 25, 38))
        lf = load_font(FONT_EN_BOLD, 24)
        draw.text((inner_x + 20, inner_y + 20), "Your subscription", fill=WHITE, font=lf)
        rows = [("Email", "copy@rashad.tech"), ("Password", "••••••••"), ("TV Code", "Request")]
        ly = inner_y + 64
        for i, (k, v) in enumerate(rows):
            a = stagger(progress, i, 0.1)
            val_color = GREEN if v == "Request" else WHITE
            draw.text((inner_x + 20, ly), k, fill=blend(BG_RGB, DIM, a), font=load_font(FONT_EN, 16))
            draw.text((inner_x + inner_w - 140, ly), v, fill=blend(BG_RGB, val_color, a), font=load_font(FONT_EN_BOLD, 16))
            ly += 42


def render_slide(slide: dict, lang: str, progress: float) -> Image.Image:
    rtl = lang == "ar"
    bold = FONT_AR_BOLD if rtl else FONT_EN_BOLD
    regular = FONT_AR if rtl else FONT_EN
    stype = slide["type"]

    img = draw_cinematic_bg(progress)
    img = draw_top_bar(img, rtl, progress)
    draw = ImageDraw.Draw(img)
    content_w = W - margin * 2

    if stype == "hero":
        p0 = stagger(progress, 0, 0.1)
        p1 = stagger(progress, 1, 0.1)
        p2 = stagger(progress, 2, 0.1)

        kf = load_font(bold, 20)
        kicker = slide["kicker"]
        tw = draw.textlength(kicker, font=kf)
        draw.text((W // 2 - tw // 2, 200), kicker, fill=blend(BG_RGB, RED_GLOW, p0), font=kf)

        scale = 0.85 + 0.15 * ease_out_back(p1)
        tf = load_font(FONT_EN_BOLD, int(108 * scale))
        title = slide["title"]
        tw = draw.textlength(title, font=tf)
        draw.text((W // 2 - tw // 2 - 40, 290), title, fill=WHITE, font=tf)
        sf = load_font(FONT_EN_BOLD, int(72 * scale))
        suffix = slide["suffix"]
        sw = draw.textlength(suffix, font=sf)
        draw.text((W // 2 - tw // 2 - 40 + tw + 8, 320), suffix, fill=RED_HEX, font=sf)

        subf = load_font(regular, 34)
        sub = slide["subtitle"]
        stw = draw.textlength(sub, font=subf)
        draw.text((W // 2 - stw // 2, 430), sub, fill=blend(BG_RGB, MUTED, p2), font=subf)

        line_w = int(200 * p2)
        draw.line([(W // 2 - line_w // 2, 490), (W // 2 + line_w // 2, 490)], fill=RED_HEX, width=3)

        y = 540
        x_start = margin
        gap = 18
        row_y = y
        x = x_start
        max_row_w = content_w
        for i, badge in enumerate(slide["badges"]):
            bp = stagger(progress, 3 + i * 0.35, 0.08)
            if bp <= 0:
                continue
            color = BRAND_COLORS.get(badge, (40, 40, 55))
            bf = load_font(bold, 22)
            pad_x, pad_y = 26, 14
            bw = draw.textlength(badge, font=bf) + pad_x * 2
            if x + bw > margin + max_row_w:
                x = x_start
                row_y += 62
            by = row_y + int(20 * (1 - bp))
            fill = blend(BG_RGB, color, bp * 0.85)
            draw.rounded_rectangle((x, by, x + bw, by + 52), radius=26, fill=fill, outline=blend(BG_RGB, WHITE, bp * 0.2), width=1)
            draw.text((x + pad_x, by + pad_y), badge, fill=blend(BG_RGB, WHITE, bp), font=bf)
            x += bw + gap

    elif stype == "split":
        ph = stagger(progress, 0, 0.15)
        hf = load_font(bold, 48)
        headline = slide["headline"]
        draw_text_rtl(draw, margin, 120, headline, hf, WHITE, rtl, content_w)

        panel_y, panel_h = 220, 620
        left_box = (margin, panel_y, W // 2 - 30, panel_y + panel_h)
        right_box = (W // 2 + 30, panel_y, W - margin, panel_y + panel_h)

        left_img = glass_panel(img, left_box, 28)
        right_img = glass_panel(left_img, right_box, 28)
        img = right_img
        draw = ImageDraw.Draw(img)

        tf = load_font(bold, 34)
        body_f = load_font(regular, 26)

        for side, box, title_key, items_key, bad in (
            ("left", left_box, "left_title", "left_items", True),
            ("right", right_box, "right_title", "right_items", False),
        ):
            sp = stagger(progress, 1 if side == "left" else 2, 0.12)
            x1, y1, x2, y2 = box
            title = slide[title_key]
            ox = x1 + 36
            if rtl:
                tw = draw.textlength(title, font=tf)
                ox = x2 - 36 - tw
            title_color = DIM if bad else GREEN
            draw.text((ox, y1 + 36), title, fill=title_color, font=tf)

            ly = y1 + 110
            for i, item in enumerate(slide[items_key]):
                ip = stagger(sp, i, 0.1)
                if ip <= 0:
                    continue
                mark = "✕  " if bad else "✓  "
                base_color = (140, 140, 155) if bad else GREEN
                line = mark + item
                text_color = blend(BG_RGB, base_color, ip)
                if rtl:
                    tw = draw.textlength(line, font=body_f)
                    draw.text((x2 - 36 - tw, ly), line, fill=text_color, font=body_f)
                else:
                    draw.text((x1 + 36, ly), line, fill=text_color, font=body_f)
                ly += 56

    elif stype == "advantage":
        num_p = stagger(progress, 0, 0.1)
        vis_p = stagger(progress, 1, 0.15)

        tag_f = load_font(FONT_EN_BOLD, 72)
        draw.text((margin, 150), slide["num"], fill=blend(BG_RGB, RED, num_p * 0.35), font=tag_f)

        tf = load_font(bold, 52)
        y = 170
        draw_wrapped(draw, slide["title"], margin, y, content_w // 2 + 80, tf, WHITE, rtl, 12)

        bf = load_font(regular, 28)
        draw_wrapped(draw, slide["body"], margin, 340, content_w // 2 + 60, bf, MUTED, rtl, 14)

        phone_w, phone_h = 420, 720
        px = W - margin - phone_w - 40
        py = 180 + int(30 * (1 - vis_p))
        phone_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        pd = ImageDraw.Draw(phone_layer)
        render_phone_mock(pd, px, py, phone_w, phone_h, slide["visual"], progress)
        img = Image.alpha_composite(img.convert("RGBA"), phone_layer).convert("RGB")

        glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse((px - 40, py + 200, px + phone_w + 40, py + phone_h + 60), fill=(*RED, int(30 * vis_p)))
        img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")

    elif stype == "products":
        tp = stagger(progress, 0, 0.1)
        tf = load_font(bold, 54)
        draw_text_rtl(draw, margin, 140, slide["title"], tf, WHITE, rtl, content_w)

        cols, cell_w, cell_h, gap = 3, 500, 150, 28
        start_x = (W - (cols * cell_w + (cols - 1) * gap)) // 2
        y0 = 280
        for i, (icon, name) in enumerate(slide["products"]):
            cp = stagger(progress, 1 + i * 0.12, 0.08)
            if cp <= 0:
                continue
            col, row = i % cols, i // cols
            x = start_x + col * (cell_w + gap)
            cy = y0 + row * (cell_h + gap) + int(25 * (1 - cp))
            color = BRAND_COLORS.get(name, (35, 35, 50))
            box = (x, cy, x + cell_w, cy + cell_h)
            img = glass_panel(img, box, 22)
            draw = ImageDraw.Draw(img)
            draw.rounded_rectangle((x + 20, cy + 28, x + 80, cy + 88), radius=16, fill=blend(BG_RGB, color, cp))
            icon_f = load_font(FONT_EN_BOLD, 32)
            iw = draw.textlength(icon, font=icon_f)
            draw.text((x + 50 - iw // 2, cy + 38), icon, fill=WHITE, font=icon_f)
            nf = load_font(bold, 30)
            draw.text((x + 100, cy + 52), name, fill=blend(BG_RGB, WHITE, cp), font=nf)

    elif stype == "steps":
        tp = stagger(progress, 0, 0.1)
        tf = load_font(bold, 52)
        draw_text_rtl(draw, margin, 130, slide["title"], tf, WHITE, rtl, content_w)

        step_w = (content_w - 80) // 3
        y = 260
        for i, (num, title, sub) in enumerate(slide["steps"]):
            sp = stagger(progress, 1 + i * 0.15, 0.1)
            if sp <= 0:
                continue
            x = margin + i * (step_w + 40)
            sy = y + int(40 * (1 - sp))
            box = (x, sy, x + step_w, sy + 300)
            img = glass_panel(img, box, 24)
            draw = ImageDraw.Draw(img)
            cx = x + step_w // 2
            r = 36
            draw.ellipse((cx - r, sy + 36 - r, cx + r, sy + 36 + r), fill=blend(BG_RGB, RED, sp))
            nf = load_font(FONT_EN_BOLD, 26)
            nw = draw.textlength(num, font=nf)
            draw.text((cx - nw // 2, sy + 22), num, fill=WHITE, font=nf)
            tff = load_font(bold, 28)
            ly = sy + 100
            for line in wrap_text(draw, title, tff, step_w - 48):
                tw = draw.textlength(line, font=tff)
                draw.text((x + (step_w - tw) // 2, ly), line, fill=WHITE, font=tff)
                ly += 34
            sf = load_font(regular, 22)
            ly += 8
            for line in wrap_text(draw, sub, sf, step_w - 48):
                tw = draw.textlength(line, font=sf)
                draw.text((x + (step_w - tw) // 2, ly), line, fill=MUTED, font=sf)
                ly += 28

    elif stype == "cta":
        tp = stagger(progress, 0, 0.12)
        up = stagger(progress, 1, 0.12)
        cp = stagger(progress, 2, 0.1)

        tf = load_font(bold, 58)
        title = slide["title"]
        tw = draw.textlength(title, font=tf)
        draw.text((W // 2 - tw // 2, 160), title, fill=blend(BG_RGB, WHITE, tp), font=tf)

        uf = load_font(FONT_EN_BOLD, 88)
        url = slide["url"]
        uw = draw.textlength(url, font=uf)
        draw.text((W // 2 - uw // 2, 270), url, fill=RED_HEX, font=uf)

        card_box = (margin + 280, 430, W - margin - 280, 700)
        img = glass_panel(img, card_box, 28)
        draw = ImageDraw.Draw(img)
        ly = 470
        cf = load_font(regular, 30)
        for i, line in enumerate(slide["lines"]):
            lp = stagger(cp, i, 0.12)
            tw = draw.textlength(line, font=cf)
            draw.text((W // 2 - tw // 2, ly), line, fill=blend(BG_RGB, WHITE, lp), font=cf)
            ly += 58

        bf = load_font(bold, 24)
        btn = "Visit now →" if lang == "en" else "زر الموقع ←"
        bw = draw.textlength(btn, font=bf) + 60
        bx = W // 2 - bw // 2
        by = 740 + int(20 * (1 - up))
        draw.rounded_rectangle((bx, by, bx + bw, by + 56), radius=28, fill=blend(BG_RGB, RED, up))
        draw.text((bx + 30, by + 14), btn, fill=WHITE, font=bf)

    elif stype == "outro":
        op = ease_out_back(clamp(progress / 0.7))
        fp = stagger(progress, 1, 0.15)
        cx, cy = W // 2, 340
        size = max(int(90 * op), 8)
        mark_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        md = ImageDraw.Draw(mark_layer)
        draw_brand_mark(md, cx, cy, size, int(255 * op))
        img = Image.alpha_composite(img.convert("RGBA"), mark_layer).convert("RGB")
        draw = ImageDraw.Draw(img)

        tf = load_font(bold, 56)
        title = slide["title"]
        tw = draw.textlength(title, font=tf)
        draw.text((W // 2 - tw // 2, 500), title, fill=blend(BG_RGB, WHITE, fp), font=tf)
        sf = load_font(regular, 32)
        sub = slide["subtitle"]
        stw = draw.textlength(sub, font=sf)
        draw.text((W // 2 - stw // 2, 580), sub, fill=blend(BG_RGB, MUTED, fp), font=sf)

        uf = load_font(FONT_EN_BOLD, 40)
        url = "rashadtech.tv"
        uw = draw.textlength(url, font=uf)
        draw.text((W // 2 - uw // 2, 660), url, fill=RED_HEX, font=uf)

    return img


def write_segment(slide: dict, lang: str, duration: float, seg_path: Path):
    total = max(int(duration * FPS), 1)
    tmp = Path(tempfile.mkdtemp(prefix="promo-seg-"))
    try:
        for i in range(total):
            t = i / max(total - 1, 1)
            frame = render_slide(slide, lang, t)
            frame.save(tmp / f"{i:05d}.png")
        subprocess.run(
            [
                "ffmpeg", "-y", "-framerate", str(FPS), "-i", str(tmp / "%05d.png"),
                "-vf", f"fade=t=in:st=0:d={FADE},fade=t=out:st={duration - FADE}:d={FADE}",
                "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                "-pix_fmt", "yuv420p", "-t", str(duration), str(seg_path),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def concat_with_xfade(segments: list[Path], output: Path, durations: list[float]):
    if len(segments) == 1:
        shutil.copy(segments[0], output)
        return

    inputs = []
    for seg in segments:
        inputs.extend(["-i", str(seg)])

    xfade_d = 0.4
    parts = []
    offset = durations[0] - xfade_d
    parts.append(f"[0:v][1:v]xfade=transition=fadeblack:duration={xfade_d}:offset={offset:.3f}[v01]")
    prev = "v01"
    for i in range(2, len(segments)):
        offset += durations[i - 1] - xfade_d
        out_label = f"v{i:02d}"
        parts.append(f"[{prev}][{i}:v]xfade=transition=fadeblack:duration={xfade_d}:offset={offset:.3f}[{out_label}]")
        prev = out_label

    total_dur = sum(durations) - xfade_d * (len(segments) - 1)
    filt = ";".join(parts)
    subprocess.run(
        ["ffmpeg", "-y", *inputs, "-filter_complex", filt, "-map", f"[{prev}]",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
         "-t", f"{total_dur:.3f}", str(output)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def save_preview_frame(slide: dict, lang: str, index: int):
    FRAMES.mkdir(parents=True, exist_ok=True)
    frame = render_slide(slide, lang, 0.85)
    frame.save(FRAMES / f"promo-{lang}-{index}.png", "PNG")


def build_video(lang: str):
    slides = CONTENT[lang]
    name = f"rashadtech-promo-{lang}"
    segments: list[Path] = []
    durations: list[float] = []

    for i, slide in enumerate(slides):
        save_preview_frame(slide, lang, i)
        dur = DURATIONS.get(slide["type"], 4.5)
        seg = OUT / f"{name}-seg-{i}.mp4"
        write_segment(slide, lang, dur, seg)
        segments.append(seg)
        durations.append(dur)

    raw = OUT / f"{name}-raw.mp4"
    concat_with_xfade(segments, raw, durations)

    landscape = OUT / f"{name}-landscape.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(raw),
            "-c:v", "libx264", "-preset", "slow", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(landscape),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    vertical = OUT / f"{name}-vertical.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(landscape),
            "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
            "-c:v", "libx264", "-preset", "slow", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(vertical),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    for seg in segments:
        seg.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)

    print(f"Created {landscape} ({landscape.stat().st_size / (1024 * 1024):.1f} MB)")
    print(f"Created {vertical} ({vertical.stat().st_size / (1024 * 1024):.1f} MB)")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for lang in ("en", "ar"):
        build_video(lang)


if __name__ == "__main__":
    main()
