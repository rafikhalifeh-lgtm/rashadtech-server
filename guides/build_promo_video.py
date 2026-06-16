#!/usr/bin/env python3
"""Build rashadtech.tv customer promo videos (EN + AR)."""
from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output"
FRAMES = OUT / "promo-frames"

W, H = 1920, 1080
DURATION = 4.5
FPS = 30

RED = "#E50914"
RED_SOFT = "#ff3b3b"
BG_TOP = "#0a0a10"
BG_BOTTOM = "#14141f"
CARD = "#1a1a24"
BORDER = "#2d2d3a"
TEXT = "#ffffff"
MUTED = "#a8a8b8"
DIM = "#6b6b7a"
GREEN = "#3ecf6e"
BLUE = "#4f8ef7"

FONT_EN = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_EN_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_AR = "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf"
FONT_AR_BOLD = "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf"

CONTENT = {
    "en": [
        {
            "type": "hero",
            "kicker": "STREAMING SUBSCRIPTIONS STORE",
            "title": "rashadtech.tv",
            "subtitle": "One wallet. Every platform. Delivered instantly.",
            "badges": ["Netflix", "Shahid", "Disney+", "OSN+", "Spotify", "Games"],
        },
        {
            "type": "split",
            "left_title": "The old way",
            "left_items": ["Different sellers", "Slow delivery", "Lost credentials", "No support"],
            "right_title": "rashadtech.tv",
            "right_items": ["One trusted store", "Instant Telegram delivery", "Private subscription link", "Real support"],
        },
        {
            "type": "advantage",
            "icon": "⚡",
            "tag": "ADVANTAGE 01",
            "title": "Instant delivery on Telegram",
            "body": "Buy once — receive email, password, and your private link in seconds. No waiting. No screenshots from strangers.",
        },
        {
            "type": "advantage",
            "icon": "💳",
            "tag": "ADVANTAGE 02",
            "title": "Smart wallet system",
            "body": "Top up your balance once, then purchase anytime in one tap. Track every transaction in your account.",
        },
        {
            "type": "advantage",
            "icon": "🔗",
            "tag": "ADVANTAGE 03",
            "title": "Your private subscription page",
            "body": "One secure link for credentials, Netflix codes, TV activation, and Shahid password reset — always available.",
        },
        {
            "type": "products",
            "title": "Everything in one store",
            "body": "Video · Music · Games · Gift cards",
            "products": [
                ("🍿", "Netflix"),
                ("ش", "Shahid VIP"),
                ("✨", "Disney+"),
                ("📺", "OSN+"),
                ("🎵", "Spotify"),
                ("🎮", "PUBG & more"),
            ],
        },
        {
            "type": "steps",
            "title": "Start in 3 simple steps",
            "steps": [
                ("1", "Create your account", "Sign up in under a minute"),
                ("2", "Top up wallet", "Add balance securely"),
                ("3", "Buy & enjoy", "Credentials arrive on Telegram"),
            ],
        },
        {
            "type": "trust",
            "title": "Built for real customers",
            "items": [
                "🔒 Secure accounts & encrypted links",
                "🌍 English & Arabic experience",
                "💬 WhatsApp & Telegram support",
                "📱 Works on phone, tablet & TV",
            ],
        },
        {
            "type": "cta",
            "title": "Start watching today",
            "url": "rashadtech.tv",
            "lines": [
                "📱 WhatsApp: +961 79 306 701",
                "✈️ Telegram: @Rashadtech",
                "🤖 Bot: @Rashadtech_bot",
            ],
        },
        {
            "type": "outro",
            "title": "Created by RashadTech",
            "subtitle": "Professional streaming subscriptions",
            "url": "rashadtech.tv",
        },
    ],
    "ar": [
        {
            "type": "hero",
            "kicker": "متجر اشتراكات البث",
            "title": "rashadtech.tv",
            "subtitle": "محفظة واحدة. كل المنصات. توصيل فوري.",
            "badges": ["نتفليكس", "شاهد", "ديزني+", "OSN+", "سبوتيفاي", "ألعاب"],
        },
        {
            "type": "split",
            "left_title": "الطريقة القديمة",
            "left_items": ["بائعون مختلفون", "تأخير في التسليم", "بيانات ضائعة", "بدون دعم"],
            "right_title": "rashadtech.tv",
            "right_items": ["متجر موثوق واحد", "توصيل فوري على تيليغرام", "رابط اشتراك خاص", "دعم حقيقي"],
        },
        {
            "type": "advantage",
            "icon": "⚡",
            "tag": "ميزة 01",
            "title": "توصيل فوري على تيليغرام",
            "body": "اشترِ مرة واحدة — استلم الإيميل وكلمة المرور ورابطك الخاص خلال ثوانٍ. بدون انتظار.",
        },
        {
            "type": "advantage",
            "icon": "💳",
            "tag": "ميزة 02",
            "title": "نظام محفظة ذكي",
            "body": "عبّئ رصيدك مرة واحدة واشترِ في أي وقت بلمسة. تتبع كل معاملة من حسابك.",
        },
        {
            "type": "advantage",
            "icon": "🔗",
            "tag": "ميزة 03",
            "title": "صفحة اشتراك خاصة بك",
            "body": "رابط آمن واحد للبيانات وأكواد نتفليكس وتفعيل التلفزيون وإعادة تعيين شاهد.",
        },
        {
            "type": "products",
            "title": "كل شيء في متجر واحد",
            "body": "فيديو · موسيقى · ألعاب · بطاقات هدايا",
            "products": [
                ("🍿", "نتفليكس"),
                ("ش", "شاهد VIP"),
                ("✨", "ديزني+"),
                ("📺", "OSN+"),
                ("🎵", "سبوتيفاي"),
                ("🎮", "ببجي والمزيد"),
            ],
        },
        {
            "type": "steps",
            "title": "ابدأ بثلاث خطوات",
            "steps": [
                ("1", "أنشئ حسابك", "تسجيل خلال دقيقة"),
                ("2", "عبّئ المحفظة", "أضف رصيدك بأمان"),
                ("3", "اشترِ واستمتع", "البيانات تصل على تيليغرام"),
            ],
        },
        {
            "type": "trust",
            "title": "مصمم لعملاء حقيقيين",
            "items": [
                "🔒 حسابات آمنة وروابط مشفرة",
                "🌍 واجهة عربية وإنجليزية",
                "💬 دعم واتساب وتيليغرام",
                "📱 يعمل على الموبايل والتلفزيون",
            ],
        },
        {
            "type": "cta",
            "title": "ابدأ المشاهدة اليوم",
            "url": "rashadtech.tv",
            "lines": [
                "📱 واتساب: +961 79 306 701",
                "✈️ تيليغرام: @Rashadtech",
                "🤖 البوت: @Rashadtech_bot",
            ],
        },
        {
            "type": "outro",
            "title": "من إنشاء RashadTech",
            "subtitle": "متجر اشتراكات احترافي",
            "url": "rashadtech.tv",
        },
    ],
}


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def gradient_bg() -> Image.Image:
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)
    for y in range(H):
        t = y / max(H - 1, 1)
        r = int(10 + (20 - 10) * t)
        g = int(10 + (20 - 10) * t)
        b = int(16 + (31 - 16) * t)
        draw.line([(0, y), (W, y)], fill=(r, g, b))
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.ellipse((W - 520, -180, W + 120, 460), fill=(229, 9, 20, 35))
    od.ellipse((-200, H - 320, 420, H + 120), fill=(79, 142, 247, 22))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def draw_glow_bar(draw: ImageDraw.ImageDraw, y: int):
    draw.rounded_rectangle((120, y, W - 120, y + 4), radius=2, fill=RED)


def wrap_text(draw, text, font, max_width):
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
    return lines


def draw_wrapped(draw, text, x, y, max_width, font, fill, rtl, gap=12):
    for line in wrap_text(draw, text, font, max_width):
        if rtl:
            tw = draw.textlength(line, font=font)
            draw.text((x + max_width - tw, y), line, fill=fill, font=font)
        else:
            draw.text((x, y), line, fill=fill, font=font)
        y += font.size + gap
    return y


def render_slide(slide: dict, lang: str, index: int) -> Path:
    rtl = lang == "ar"
    title_font = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 62 if slide["type"] == "hero" else 54)
    body_font = load_font(FONT_AR if rtl else FONT_EN, 30)
    small_font = load_font(FONT_AR if rtl else FONT_EN, 24)
    kicker_font = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 22)
    margin = 100
    content_w = W - margin * 2

    img = gradient_bg()
    draw = ImageDraw.Draw(img)
    draw_glow_bar(draw, 48)

    stype = slide["type"]

    if stype == "hero":
        kicker = slide["kicker"]
        if rtl:
            tw = draw.textlength(kicker, font=kicker_font)
            draw.text((margin + content_w - tw, 120), kicker, fill=RED_SOFT, font=kicker_font)
        else:
            draw.text((margin, 120), kicker, fill=RED_SOFT, font=kicker_font)
        title = slide["title"]
        tf = load_font(FONT_EN_BOLD, 96)
        tw = draw.textlength(title, font=tf)
        draw.text(((W - tw) / 2, 260), title, fill=TEXT, font=tf)
        sub = slide["subtitle"]
        sf = load_font(FONT_AR if rtl else FONT_EN, 38)
        tw = draw.textlength(sub, font=sf)
        draw.text(((W - tw) / 2, 390), sub, fill=MUTED, font=sf)
        y = 520
        x = margin
        gap = 16
        for badge in slide["badges"]:
            bf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 22)
            pad_x, pad_y = 22, 12
            bw = draw.textlength(badge, font=bf) + pad_x * 2
            if x + bw > W - margin:
                x = margin
                y += 56
            draw.rounded_rectangle((x, y, x + bw, y + 48), radius=24, fill=CARD, outline=BORDER, width=1)
            draw.text((x + pad_x, y + pad_y), badge, fill=TEXT, font=bf)
            x += bw + gap
    elif stype == "split":
        mid = W // 2
        draw.line([(mid, 140), (mid, H - 140)], fill=BORDER, width=2)
        for side, ox, color, title_key, items_key in (
            ("left", margin, DIM, "left_title", "left_items"),
            ("right", mid + 60, TEXT, "right_title", "right_items"),
        ):
            title = slide[title_key]
            tf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 40)
            items = slide[items_key]
            y = 160
            if rtl:
                tw = draw.textlength(title, font=tf)
                tx = (mid - margin - tw) if side == "left" else (W - margin - tw)
            else:
                tx = ox if side == "left" else ox
            draw.text((tx, y), title, fill=RED if side == "right" else color, font=tf)
            y += 70
            for item in items:
                mark = "✓ " if side == "right" else "✗ "
                line = mark + item
                if rtl:
                    tw = draw.textlength(line, font=body_font)
                    ix = (mid - margin - tw - 20) if side == "left" else (W - margin - tw)
                else:
                    ix = ox
                draw.text((ix, y), line, fill=color if side == "left" else GREEN if side == "right" else TEXT, font=body_font)
                y += 52
    elif stype == "advantage":
        icon_font = load_font(FONT_EN, 88)
        draw.text((margin, 130), slide["icon"], font=icon_font, embedded_color=True)
        tag = slide["tag"]
        draw.text((margin + 120, 150), tag, fill=RED_SOFT, font=kicker_font)
        y = 250
        if rtl:
            tw = draw.textlength(slide["title"], font=title_font)
            draw.text((margin + content_w - tw, y), slide["title"], fill=TEXT, font=title_font)
        else:
            draw.text((margin, y), slide["title"], fill=TEXT, font=title_font)
        y += 90
        draw_wrapped(draw, slide["body"], margin, y, content_w - 200, body_font, MUTED, rtl, 14)
        draw.rounded_rectangle((W - 220, 180, W - 100, H - 180), radius=20, outline=RED, width=3)
    elif stype == "products":
        y = 150
        if rtl:
            tw = draw.textlength(slide["title"], font=title_font)
            draw.text((margin + content_w - tw, y), slide["title"], fill=TEXT, font=title_font)
        else:
            draw.text((margin, y), slide["title"], fill=TEXT, font=title_font)
        y += 80
        tw = draw.textlength(slide["body"], font=body_font)
        draw.text(((W - tw) / 2, y), slide["body"], fill=MUTED, font=body_font)
        y += 80
        cols, cell_w, cell_h, gap = 3, 500, 130, 28
        start_x = (W - (cols * cell_w + (cols - 1) * gap)) // 2
        for i, (icon, name) in enumerate(slide["products"]):
            col, row = i % cols, i // cols
            x = start_x + col * (cell_w + gap)
            cy = y + row * (cell_h + gap)
            draw.rounded_rectangle((x, cy, x + cell_w, cy + cell_h), radius=18, fill=CARD, outline=BORDER, width=1)
            draw.text((x + 28, cy + 36), icon, font=load_font(FONT_EN, 42), embedded_color=True)
            nf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 30)
            draw.text((x + 90, cy + 48), name, fill=TEXT, font=nf)
    elif stype == "steps":
        y = 140
        if rtl:
            tw = draw.textlength(slide["title"], font=title_font)
            draw.text((margin + content_w - tw, y), slide["title"], fill=TEXT, font=title_font)
        else:
            draw.text((margin, y), slide["title"], fill=TEXT, font=title_font)
        y += 100
        step_w = (content_w - 80) // 3
        for i, (num, title, sub) in enumerate(slide["steps"]):
            x = margin + i * (step_w + 40)
            draw.rounded_rectangle((x, y, x + step_w, y + 280), radius=20, fill=CARD, outline=BORDER, width=1)
            r = 34
            cx, cy = x + step_w // 2, y + 50
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED)
            nf = load_font(FONT_EN_BOLD, 32)
            draw.text((cx - draw.textlength(num, font=nf) / 2, cy - 18), num, fill=TEXT, font=nf)
            tf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 28)
            title_lines = wrap_text(draw, title, tf, step_w - 40)
            ly = y + 110
            for line in title_lines:
                tw = draw.textlength(line, font=tf)
                draw.text((x + (step_w - tw) / 2, ly), line, fill=TEXT, font=tf)
                ly += 36
            ly += 8
            for line in wrap_text(draw, sub, small_font, step_w - 40):
                tw = draw.textlength(line, font=small_font)
                draw.text((x + (step_w - tw) / 2, ly), line, fill=MUTED, font=small_font)
                ly += 30
    elif stype == "trust":
        y = 150
        if rtl:
            tw = draw.textlength(slide["title"], font=title_font)
            draw.text((margin + content_w - tw, y), slide["title"], fill=TEXT, font=title_font)
        else:
            draw.text((margin, y), slide["title"], fill=TEXT, font=title_font)
        y += 100
        card_h = 420
        draw.rounded_rectangle((margin, y, margin + content_w, y + card_h), radius=24, fill=CARD, outline=BORDER, width=1)
        ly = y + 50
        for item in slide["items"]:
            if rtl:
                tw = draw.textlength(item, font=body_font)
                draw.text((margin + content_w - tw - 50, ly), item, fill=TEXT, font=body_font)
            else:
                draw.text((margin + 50, ly), item, fill=TEXT, font=body_font)
            ly += 78
    elif stype == "cta":
        title = slide["title"]
        tw = draw.textlength(title, font=title_font)
        draw.text(((W - tw) / 2, 180), title, fill=TEXT, font=title_font)
        url = slide["url"]
        uf = load_font(FONT_EN_BOLD, 72)
        uw = draw.textlength(url, font=uf)
        draw.text(((W - uw) / 2, 300), url, fill=RED_SOFT, font=uf)
        card_y = 450
        draw.rounded_rectangle((margin + 200, card_y, W - margin - 200, card_y + 240), radius=24, fill=CARD, outline=BORDER, width=1)
        ly = card_y + 50
        for line in slide["lines"]:
            tw = draw.textlength(line, font=body_font)
            draw.text(((W - tw) / 2, ly), line, fill=TEXT, font=body_font)
            ly += 58
    elif stype == "outro":
        draw.ellipse((W // 2 - 80, 200, W // 2 + 80, 360), outline=RED, width=4)
        star = load_font(FONT_EN, 72)
        draw.text((W // 2 - 28, 248), "★", fill=RED, font=star)
        title = slide["title"]
        tf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 56)
        tw = draw.textlength(title, font=tf)
        draw.text(((W - tw) / 2, 400), title, fill=TEXT, font=tf)
        sub = slide["subtitle"]
        sf = load_font(FONT_AR if rtl else FONT_EN, 32)
        tw = draw.textlength(sub, font=sf)
        draw.text(((W - tw) / 2, 490), sub, fill=MUTED, font=sf)
        url = slide["url"]
        uf = load_font(FONT_EN_BOLD, 48)
        uw = draw.textlength(url, font=uf)
        draw.text(((W - uw) / 2, 580), url, fill=RED_SOFT, font=uf)

    footer = "rashadtech.tv"
    ff = load_font(FONT_EN, 22)
    draw.text(((W - draw.textlength(footer, font=ff)) / 2, H - 60), footer, fill=DIM, font=ff)

    FRAMES.mkdir(parents=True, exist_ok=True)
    path = FRAMES / f"promo-{lang}-{index}.png"
    img.save(path, "PNG")
    return path


def segment_from_frame(frame: Path, seg: Path, duration: float):
    frames = int(duration * FPS)
    subprocess.run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(frame),
            "-vf", (
                f"scale={W}:{H},format=yuv420p,"
                f"zoompan=z='min(zoom+0.0008,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
                f"d={frames}:s={W}x{H}:fps={FPS}"
            ),
            "-c:v", "libx264", "-t", str(duration), "-pix_fmt", "yuv420p",
            str(seg),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def build_video(lang: str):
    slides = CONTENT[lang]
    name = f"rashadtech-promo-{lang}"
    durations = {
        "hero": 5.0,
        "split": 5.0,
        "advantage": 4.5,
        "products": 5.0,
        "steps": 5.0,
        "trust": 4.5,
        "cta": 5.0,
        "outro": 4.5,
    }
    seg_files = []
    for i, slide in enumerate(slides):
        frame = render_slide(slide, lang, i)
        dur = durations.get(slide["type"], DURATION)
        seg = OUT / f"{name}-{i}.mp4"
        segment_from_frame(frame, seg, dur)
        seg_files.append(seg)

    list_path = OUT / f"{name}-list.txt"
    with list_path.open("w") as f:
        for seg in seg_files:
            f.write(f"file '{seg}'\n")

    landscape = OUT / f"{name}-landscape.mp4"
    vertical = OUT / f"{name}-vertical.mp4"
    raw = OUT / f"{name}-raw.mp4"

    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(raw)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(raw),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(landscape),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", str(landscape),
            "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(vertical),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    for seg in seg_files:
        seg.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)
    list_path.unlink(missing_ok=True)

    print(f"Created {landscape} ({landscape.stat().st_size / (1024 * 1024):.1f} MB)")
    print(f"Created {vertical} ({vertical.stat().st_size / (1024 * 1024):.1f} MB)")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for lang in ("en", "ar"):
        build_video(lang)


if __name__ == "__main__":
    main()
