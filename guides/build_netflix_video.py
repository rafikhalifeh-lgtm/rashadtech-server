#!/usr/bin/env python3
"""Render Netflix sign-in tutorial slides and build MP4 videos."""
from __future__ import annotations

import os
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output"
FRAMES = OUT / "frames"
DURATION = 6
SLIDES = 8

FONT_EN = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_EN_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_AR = "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf"
FONT_AR_BOLD = "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf"

W, H = 1080, 1920
RED = "#E50914"
BG = "#0a0a0a"
CARD = "#1a1a1a"
BORDER = "#333333"
TEXT = "#ffffff"
MUTED = "#b3b3b3"
DIM = "#888888"

CONTENT = {
    "en": [
        {
            "type": "intro",
            "icon": "🍿",
            "title": "How to sign in to Netflix",
            "body": "After your purchase — quick guide for phone, tablet & TV",
        },
        {
            "step": 1,
            "title": "Open your subscription link",
            "body": "After purchase you receive a link on Telegram or WhatsApp. Tap it — it opens your private page on rashadtech.tv.",
            "card": ["Example link", "rashadtech.tv?t=••••••"],
        },
        {
            "step": 2,
            "title": "Copy email & password",
            "body": "On the subscription page, tap Email or Password to copy. Tap the 👁 icon to reveal the password.",
            "card": [
                ("Email", "you@email.com"),
                ("Password", "••••••••"),
                ("Profile PIN", "1234"),
            ],
            "note": "PIN appears on 1 User plans only.",
        },
        {
            "step": 3,
            "title": "Log in to Netflix",
            "body": "Open the Netflix app or go to netflix.com/login. Paste the email and password you copied.",
            "card_btn": "Sign In to Netflix",
            "note": "For 1 User plans: choose your profile name and enter your PIN.",
        },
        {
            "step": 4,
            "tag": "IF NETFLIX ASKS FOR A CODE",
            "title": "Request sign-in code",
            "body": "Go back to your subscription link. Tap Request Sign-in Code, wait a few seconds, then tap Refresh.",
            "card_btn": "📲 Request Sign-in Code",
            "code": "4 8 2 9",
            "card_btn2": "🔄 Refresh",
            "note": "Enter the code in Netflix. Codes expire quickly — use the newest one.",
        },
        {
            "step": 5,
            "tag": "WATCH ON TV",
            "title": "Activate on your TV",
            "body": "A) Log in to Netflix on your phone first.\nB) Open Netflix on TV — it shows a code.\nC) On your subscription link, enter the code under Activate on TV.",
            "tv_code": "AB12CD",
            "card_btn": "📺 Activate",
        },
        {
            "step": "✓",
            "title": "You're all set!",
            "body": "Enjoy Netflix. Keep your subscription link — open it anytime for credentials, codes, and TV activation.",
            "rules": [
                "❌ Don't change the Netflix password",
                "❌ Don't add your own phone number for 2FA",
                "✅ Use only your assigned profile (1 User plans)",
            ],
        },
        {
            "type": "support",
            "icon": "💬",
            "title": "Need help?",
            "body": "Contact us anytime:",
            "lines": [
                "📱 WhatsApp: +961 79 306 701",
                "✈️ Telegram: @Rashadtech",
                "🤖 Bot: @Rashadtech_bot",
                "🌐 rashadtech.tv",
            ],
            "footer": "Thank you for choosing RashadTech 🌟",
        },
    ],
    "ar": [
        {
            "type": "intro",
            "icon": "🍿",
            "title": "كيف تسجّل دخول نتفليكس",
            "body": "بعد الشراء — دليل سريع للموبايل والتابلت والتلفزيون",
        },
        {
            "step": 1,
            "title": "افتح رابط الاشتراك",
            "body": "بعد الشراء تستلم رابط على تيليغرام أو واتساب. اضغط عليه — يفتح صفحتك الخاصة على rashadtech.tv.",
            "card": ["مثال على الرابط", "rashadtech.tv?t=••••••"],
        },
        {
            "step": 2,
            "title": "انسخ الإيميل وكلمة المرور",
            "body": "في صفحة الاشتراك، اضغط على الإيميل أو كلمة المرور للنسخ. اضغط 👁 لإظهار كلمة المرور.",
            "card": [
                ("الإيميل", "you@email.com"),
                ("كلمة المرور", "••••••••"),
                ("رمز البروفايل", "1234"),
            ],
            "note": "الرمز يظهر في باقات مستخدم واحد فقط.",
        },
        {
            "step": 3,
            "title": "سجّل دخول نتفليكس",
            "body": "افتح تطبيق نتفليكس أو netflix.com/login. الصق الإيميل وكلمة المرور.",
            "card_btn": "تسجيل الدخول لنتفليكس",
            "note": "لباقات مستخدم واحد: اختر اسم البروفايل وأدخل الرمز.",
        },
        {
            "step": 4,
            "tag": "إذا طلب نتفليكس رمزاً",
            "title": "اطلب رمز تسجيل الدخول",
            "body": "ارجع لرابط الاشتراك. اضغط Request Sign-in Code، انتظر ثوانٍ، ثم اضغط Refresh.",
            "card_btn": "📲 Request Sign-in Code",
            "code": "4 8 2 9",
            "card_btn2": "🔄 Refresh",
            "note": "أدخل الرمز في نتفليكس. الرموز تنتهي بسرعة — استخدم الأحدث.",
        },
        {
            "step": 5,
            "tag": "شاهد على التلفزيون",
            "title": "فعّل على التلفزيون",
            "body": "أ) سجّل دخول نتفليكس من الموبايل أولاً.\nب) افتح نتفليكس على التلفزيون — يظهر كود.\nج) في رابط الاشتراك، أدخل الكود تحت Activate on TV.",
            "tv_code": "AB12CD",
            "card_btn": "📺 Activate",
        },
        {
            "step": "✓",
            "title": "جاهز للمشاهدة!",
            "body": "استمتع بنتفليكس. احفظ رابط الاشتراك — تقدر تفتحه أي وقت للبيانات والأكواد وتفعيل التلفزيون.",
            "rules": [
                "❌ لا تغيّر كلمة مرور نتفليكس",
                "❌ لا تضف رقم هاتفك للتحقق بخطوتين",
                "✅ استخدم البروفايل المخصص لك فقط",
            ],
        },
        {
            "type": "support",
            "icon": "💬",
            "title": "تحتاج مساعدة؟",
            "body": "تواصل معنا:",
            "lines": [
                "📱 واتساب: +961 79 306 701",
                "✈️ تيليغرام: @Rashadtech",
                "🤖 البوت: @Rashadtech_bot",
                "🌐 rashadtech.tv",
            ],
            "footer": "شكراً لاختيارك RashadTech 🌟",
        },
    ],
}


def load_font(path: str, size: int):
    return ImageFont.truetype(path, size)


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    words = text.replace("\n", " \n ").split()
    lines: list[str] = []
    current = ""
    for word in words:
        if word == "\n":
            if current:
                lines.append(current.strip())
                current = ""
            lines.append("")
            continue
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return [ln for ln in lines if ln != ""]


def draw_brand(draw, y: int, rtl: bool):
    text = "rashadtech.tv"
    font = load_font(FONT_EN_BOLD, 34)
    x = W - 72 - draw.textlength(text, font=font) if rtl else 72
    draw.text((x, y), text, fill=RED, font=font)


def draw_footer(draw, rtl: bool, text: str = "rashadtech.tv"):
    font = load_font(FONT_EN, 26)
    x = (W - draw.textlength(text, font=font)) / 2
    draw.text((x, H - 100), text, fill=DIM, font=font)


def draw_wrapped(draw, text: str, x: int, y: int, max_width: int, font, fill: str, rtl: bool, line_gap: int = 14) -> int:
    lines = wrap_text(draw, text, font, max_width)
    for line in lines:
        if rtl:
            tw = draw.textlength(line, font=font)
            draw.text((x + max_width - tw, y), line, fill=fill, font=font)
        else:
            draw.text((x, y), line, fill=fill, font=font)
        y += font.size + line_gap
    return y


def draw_card(draw, x: int, y: int, w: int, h: int):
    draw.rounded_rectangle((x, y, x + w, y + h), radius=24, fill=CARD, outline=BORDER, width=2)


def render_slide(slide: dict, lang: str, index: int) -> Path:
    rtl = lang == "ar"
    title_font = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 52 if rtl else 56)
    body_font = load_font(FONT_AR if rtl else FONT_EN, 34 if rtl else 36)
    small_font = load_font(FONT_AR if rtl else FONT_EN, 28)
    mono_font = load_font(FONT_EN_BOLD, 34)

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    margin = 72
    content_w = W - margin * 2
    x = margin
    y = 90

    draw_brand(draw, y, rtl)
    y += 70

    if slide.get("type") == "intro":
        icon = slide["icon"]
        icon_font = load_font(FONT_EN, 110)
        draw.text(((W - draw.textlength(icon, font=icon_font)) / 2, y + 40), icon, font=icon_font, embedded_color=True)
        y += 200
        title = slide["title"]
        tw = draw.textlength(title, font=title_font)
        tx = (W - tw) / 2
        draw.text((tx, y), title, fill=TEXT, font=title_font)
        y += title_font.size + 36
        y = draw_wrapped(draw, slide["body"], margin, y, content_w, body_font, MUTED, rtl, 18)
        draw_footer(draw, rtl)
    elif slide.get("type") == "support":
        icon_font = load_font(FONT_EN, 100)
        draw.text(((W - draw.textlength(slide["icon"], font=icon_font)) / 2, y + 20), slide["icon"], font=icon_font, embedded_color=True)
        y += 170
        title = slide["title"]
        tw = draw.textlength(title, font=title_font)
        draw.text(((W - tw) / 2, y), title, fill=TEXT, font=title_font)
        y += title_font.size + 30
        y = draw_wrapped(draw, slide["body"], margin, y, content_w, body_font, MUTED, rtl)
        card_y = y + 20
        card_h = 320
        draw_card(draw, margin, card_y, content_w, card_h)
        ly = card_y + 36
        for line in slide["lines"]:
            if rtl:
                tw = draw.textlength(line, font=body_font)
                draw.text((margin + content_w - tw - 36, ly), line, fill=TEXT, font=body_font)
            else:
                draw.text((margin + 36, ly), line, fill=TEXT, font=body_font)
            ly += 58
        draw_footer(draw, rtl, slide.get("footer", "rashadtech.tv"))
    else:
        step = slide.get("step")
        if step is not None:
            r = 36
            cx = W - margin - r if rtl else margin + r
            cy = y + r
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED)
            step_text = str(step)
            sf = load_font(FONT_EN_BOLD, 34)
            stw = draw.textlength(step_text, font=sf)
            draw.text((cx - stw / 2, cy - sf.size / 2 - 2), step_text, fill=TEXT, font=sf)
            y += 110

        if slide.get("tag"):
            tag = slide["tag"]
            tf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 24)
            pad_x, pad_y = 18, 8
            tw = draw.textlength(tag, font=tf)
            tx = W - margin - tw - pad_x * 2 if rtl else margin
            draw.rounded_rectangle((tx, y, tx + tw + pad_x * 2, y + tf.size + pad_y * 2), radius=8, fill=RED)
            draw.text((tx + pad_x, y + pad_y), tag, fill=TEXT, font=tf)
            y += tf.size + pad_y * 2 + 24

        title = slide["title"]
        if rtl:
            tw = draw.textlength(title, font=title_font)
            draw.text((margin + content_w - tw, y), title, fill=TEXT, font=title_font)
        else:
            draw.text((margin, y), title, fill=TEXT, font=title_font)
        y += title_font.size + 28
        y = draw_wrapped(draw, slide["body"], margin, y, content_w, body_font, MUTED, rtl)

        if slide.get("card"):
            card_y = y + 24
            card_h = 200
            draw_card(draw, margin, card_y, content_w, card_h)
            if isinstance(slide["card"][0], str):
                draw.text((margin + 36, card_y + 28), slide["card"][0], fill=DIM, font=small_font)
                draw.text((margin + 36, card_y + 80), slide["card"][1], fill="#4ade80", font=mono_font)
            else:
                ly = card_y + 28
                for label, value in slide["card"]:
                    if rtl:
                        draw.text((margin + content_w - 36 - draw.textlength(label, font=small_font), ly), label, fill=DIM, font=small_font)
                        draw.text((margin + 36, ly), value, fill=TEXT, font=mono_font)
                    else:
                        draw.text((margin + 36, ly), label, fill=DIM, font=small_font)
                        draw.text((margin + content_w - 36 - draw.textlength(value, font=mono_font), ly), value, fill=TEXT, font=mono_font)
                    ly += 52
            y = card_y + card_h + 20

        card_y = y + 10
        card_extra = 0
        if slide.get("card_btn"):
            card_extra = 220
        if slide.get("tv_code"):
            card_extra = 240
        if card_extra:
            draw_card(draw, margin, card_y, content_w, card_extra)
            cy = card_y + 28
            if slide.get("card_btn"):
                btn = slide["card_btn"]
                bf = load_font(FONT_AR_BOLD if rtl else FONT_EN_BOLD, 30)
                btw = draw.textlength(btn, font=bf)
                draw.rounded_rectangle((margin + 36, cy, margin + content_w - 36, cy + 64), radius=12, fill=RED)
                draw.text(((W - btw) / 2, cy + 14), btn, fill=TEXT, font=bf)
                cy += 84
            if slide.get("code"):
                code = slide["code"]
                cf = load_font(FONT_EN_BOLD, 52)
                ctw = draw.textlength(code, font=cf)
                draw.text(((W - ctw) / 2, cy), code, fill=TEXT, font=cf)
                cy += 80
            if slide.get("card_btn2"):
                btn2 = slide["card_btn2"]
                bf = load_font(FONT_EN_BOLD, 28)
                btw = draw.textlength(btn2, font=bf)
                draw.rounded_rectangle((margin + 36, cy, margin + content_w - 36, cy + 58), radius=12, fill="#b20710")
                draw.text(((W - btw) / 2, cy + 12), btn2, fill=TEXT, font=bf)
            if slide.get("tv_code"):
                code = slide["tv_code"]
                cf = load_font(FONT_EN_BOLD, 44)
                ctw = draw.textlength(code, font=cf)
                bx1, by1 = margin + 80, cy
                bx2, by2 = margin + content_w - 80, cy + 72
                draw.rounded_rectangle((bx1, by1, bx2, by2), radius=12, outline=BORDER, width=2)
                draw.text(((W - ctw) / 2, cy + 12), code, fill=TEXT, font=cf)
                cy += 92
                btn = slide.get("card_btn", "")
                bf = load_font(FONT_EN_BOLD, 30)
                btw = draw.textlength(btn, font=bf)
                draw.rounded_rectangle((margin + 36, cy, margin + content_w - 36, cy + 58), radius=12, fill=RED)
                draw.text(((W - btw) / 2, cy + 12), btn, fill=TEXT, font=bf)
            y = card_y + card_extra + 10

        if slide.get("rules"):
            card_y = y + 10
            card_h = 280
            draw_card(draw, margin, card_y, content_w, card_h)
            ly = card_y + 30
            rf = load_font(FONT_AR if rtl else FONT_EN, 30)
            for rule in slide["rules"]:
                if rtl:
                    tw = draw.textlength(rule, font=rf)
                    draw.text((margin + content_w - tw - 30, ly), rule, fill=TEXT, font=rf)
                else:
                    draw.text((margin + 30, ly), rule, fill=TEXT, font=rf)
                ly += 72
            y = card_y + card_h

        if slide.get("note"):
            y = draw_wrapped(draw, slide["note"], margin, y + 16, content_w, small_font, MUTED, rtl, 10)

        draw_footer(draw, rtl)

    FRAMES.mkdir(parents=True, exist_ok=True)
    path = FRAMES / f"{lang}-{index}.png"
    img.save(path, "PNG")
    return path


def build_video(lang: str):
    slides = CONTENT[lang]
    name = f"netflix-signin-guide-{lang}"
    seg_files = []
    for i, slide in enumerate(slides):
        frame = render_slide(slide, lang, i)
        seg = OUT / f"{name}-{i}.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-loop", "1", "-i", str(frame),
                "-c:v", "libx264", "-t", str(DURATION), "-pix_fmt", "yuv420p",
                "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
                str(seg),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        seg_files.append(seg)

    list_path = OUT / f"{name}-list.txt"
    with list_path.open("w") as f:
        for seg in seg_files:
            f.write(f"file '{seg}'\n")

    raw = OUT / f"{name}-raw.mp4"
    final = OUT / f"{name}.mp4"
    landscape = OUT / f"{name}-landscape.mp4"

    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(raw)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "ffmpeg", "-y", "-i", str(raw), "-vf", "fps=30", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(final),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "ffmpeg", "-y", "-i", str(final),
        "-vf", "scale=-2:1080,pad=1920:1080:(ow-iw)/2:0:black",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(landscape),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for seg in seg_files:
        seg.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)
    list_path.unlink(missing_ok=True)
    size_mb = final.stat().st_size / (1024 * 1024)
    print(f"Created {final} ({size_mb:.1f} MB)")
    print(f"Created {landscape}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for lang in ("en", "ar"):
        build_video(lang)


if __name__ == "__main__":
    main()
