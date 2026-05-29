#!/usr/bin/env python3
"""Generate a PDF presentation for the Polymarket Viewer project.

Renders a 16:9 slide deck using ReportLab. Colors mirror the app's dark theme
(see styles.css). Run:  python3 make_presentation.py
Output: polymarket-viewer-presentation.pdf
"""

from reportlab.lib.pagesizes import landscape
from reportlab.lib.units import cm
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas

# 16:9 slide canvas
PAGE_W, PAGE_H = 33.867 * cm, 19.05 * cm  # 1280x720 pt-ish, in cm
PAGE = (PAGE_W, PAGE_H)

# Palette from styles.css (dark theme)
BG       = HexColor("#0b0d12")
PANEL    = HexColor("#131722")
PANEL2   = HexColor("#1a2030")
BORDER   = HexColor("#232a3a")
TEXT     = HexColor("#e6e9ef")
MUTED    = HexColor("#8a93a6")
ACCENT   = HexColor("#4f8cff")
GREEN    = HexColor("#2ecc71")
RED      = HexColor("#ff5a6a")

MARGIN = 2.2 * cm


def bg(c):
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)


def footer(c, page_no):
    c.setFont("Helvetica", 9)
    c.setFillColor(MUTED)
    c.drawString(MARGIN, 1.0 * cm, "Polymarket Viewer")
    c.drawRightString(PAGE_W - MARGIN, 1.0 * cm, f"{page_no:02d}")
    # accent dot
    c.setFillColor(ACCENT)
    c.circle(MARGIN - 0.45 * cm, 1.13 * cm, 0.09 * cm, fill=1, stroke=0)


def accent_bar(c, y):
    c.setFillColor(ACCENT)
    c.rect(MARGIN, y, 2.4 * cm, 0.13 * cm, fill=1, stroke=0)


def wrap(c, text, font, size, max_w):
    c.setFont(font, size)
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if c.stringWidth(trial, font, size) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ----- Slide builders ----------------------------------------------------

def slide_title(c):
    bg(c)
    # subtle panel band
    c.setFillColor(PANEL)
    c.rect(0, PAGE_H * 0.32, PAGE_W, PAGE_H * 0.36, fill=1, stroke=0)

    # brand dot
    c.setFillColor(ACCENT)
    c.circle(MARGIN + 0.25 * cm, PAGE_H * 0.62, 0.28 * cm, fill=1, stroke=0)
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(MARGIN + 0.9 * cm, PAGE_H * 0.62 - 0.18 * cm, "PROJECT OVERVIEW")

    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 46)
    c.drawString(MARGIN, PAGE_H * 0.50, "Polymarket Viewer")

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 18)
    c.drawString(MARGIN, PAGE_H * 0.42,
                 "A fast, zero-dependency web app for browsing live prediction markets")

    c.setFillColor(ACCENT)
    c.setFont("Helvetica", 12)
    c.drawString(MARGIN, 3.0 * cm, "Data via Polymarket Gamma API  ·  Vanilla HTML / CSS / JS")


def slide_section(c, kicker, title, bullets, page_no):
    bg(c)
    accent_bar(c, PAGE_H - MARGIN + 0.2 * cm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, PAGE_H - MARGIN - 0.2 * cm, kicker.upper())

    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(MARGIN, PAGE_H - MARGIN - 1.35 * cm, title)

    y = PAGE_H - MARGIN - 3.1 * cm
    max_w = PAGE_W - 2 * MARGIN - 0.9 * cm
    for b in bullets:
        # bullet marker
        c.setFillColor(ACCENT)
        c.rect(MARGIN, y - 0.02 * cm, 0.22 * cm, 0.22 * cm, fill=1, stroke=0)
        lines = wrap(c, b, "Helvetica", 15, max_w)
        c.setFillColor(TEXT)
        c.setFont("Helvetica", 15)
        for i, ln in enumerate(lines):
            c.drawString(MARGIN + 0.7 * cm, y - i * 0.62 * cm, ln)
        y -= (len(lines) * 0.62 * cm) + 0.55 * cm
    footer(c, page_no)


def slide_features(c, page_no):
    bg(c)
    accent_bar(c, PAGE_H - MARGIN + 0.2 * cm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, PAGE_H - MARGIN - 0.2 * cm, "WHAT IT DOES")
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(MARGIN, PAGE_H - MARGIN - 1.35 * cm, "Key Features")

    cards = [
        ("Live market grid", "Pulls the top active markets and renders them as responsive cards."),
        ("Search", "Instant client-side filtering of markets by question text."),
        ("Sorting", "Order by 24h volume, liquidity, newest, or soonest to close."),
        ("Outcome pricing", "Shows each outcome with cents-on-the-dollar odds, color-coded Yes/No."),
        ("Refresh", "One click re-fetches the latest data from the Gamma API."),
        ("Light & dark", "Adapts automatically to the viewer's system color scheme."),
    ]
    cols, rows = 3, 2
    gap = 0.7 * cm
    grid_top = PAGE_H - MARGIN - 2.7 * cm
    grid_bottom = 2.2 * cm
    cw = (PAGE_W - 2 * MARGIN - (cols - 1) * gap) / cols
    ch = (grid_top - grid_bottom - (rows - 1) * gap) / rows

    for idx, (title, desc) in enumerate(cards):
        r, cc = divmod(idx, cols)
        x = MARGIN + cc * (cw + gap)
        y = grid_top - ch - r * (ch + gap)
        c.setFillColor(PANEL)
        c.setStrokeColor(BORDER)
        c.setLineWidth(1)
        c.roundRect(x, y, cw, ch, 0.35 * cm, fill=1, stroke=1)
        c.setFillColor(ACCENT)
        c.rect(x + 0.55 * cm, y + ch - 0.95 * cm, 0.55 * cm, 0.12 * cm, fill=1, stroke=0)
        c.setFillColor(TEXT)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(x + 0.55 * cm, y + ch - 1.7 * cm, title)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 10.5)
        for i, ln in enumerate(wrap(c, desc, "Helvetica", 10.5, cw - 1.1 * cm)):
            c.drawString(x + 0.55 * cm, y + ch - 2.4 * cm - i * 0.48 * cm, ln)
    footer(c, page_no)


def slide_flow(c, page_no):
    bg(c)
    accent_bar(c, PAGE_H - MARGIN + 0.2 * cm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, PAGE_H - MARGIN - 0.2 * cm, "HOW IT WORKS")
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(MARGIN, PAGE_H - MARGIN - 1.35 * cm, "Data Flow")

    steps = [
        ("Fetch", "GET the Gamma API for the top 60 active markets, sorted by 24h volume."),
        ("Normalize", "Parse JSON fields, coerce prices & volumes, keep markets with outcomes."),
        ("Filter & Sort", "Apply the live search term and the chosen sort order in the browser."),
        ("Render", "Clone a <template> card per market and paint it into the responsive grid."),
    ]
    n = len(steps)
    gap = 0.7 * cm
    cw = (PAGE_W - 2 * MARGIN - (n - 1) * gap) / n
    cy = PAGE_H * 0.46
    ch = 7.2 * cm
    y = cy - ch / 2
    for i, (title, desc) in enumerate(steps):
        x = MARGIN + i * (cw + gap)
        c.setFillColor(PANEL)
        c.setStrokeColor(BORDER)
        c.roundRect(x, y, cw, ch, 0.35 * cm, fill=1, stroke=1)
        # number badge
        c.setFillColor(ACCENT)
        c.circle(x + 0.95 * cm, y + ch - 1.1 * cm, 0.45 * cm, fill=1, stroke=0)
        c.setFillColor(BG)
        c.setFont("Helvetica-Bold", 16)
        c.drawCentredString(x + 0.95 * cm, y + ch - 1.32 * cm, str(i + 1))
        c.setFillColor(TEXT)
        c.setFont("Helvetica-Bold", 15)
        c.drawString(x + 0.55 * cm, y + ch - 2.5 * cm, title)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 11)
        for j, ln in enumerate(wrap(c, desc, "Helvetica", 11, cw - 1.1 * cm)):
            c.drawString(x + 0.55 * cm, y + ch - 3.3 * cm - j * 0.5 * cm, ln)
        # arrow
        if i < n - 1:
            ax = x + cw + gap / 2
            c.setStrokeColor(ACCENT)
            c.setLineWidth(2)
            c.line(ax - 0.25 * cm, cy, ax + 0.25 * cm, cy)
            c.setFillColor(ACCENT)
            c.line(ax + 0.05 * cm, cy + 0.18 * cm, ax + 0.28 * cm, cy)
            c.line(ax + 0.05 * cm, cy - 0.18 * cm, ax + 0.28 * cm, cy)
    footer(c, page_no)


def slide_stack(c, page_no):
    bg(c)
    accent_bar(c, PAGE_H - MARGIN + 0.2 * cm)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, PAGE_H - MARGIN - 0.2 * cm, "UNDER THE HOOD")
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(MARGIN, PAGE_H - MARGIN - 1.35 * cm, "Tech Stack")

    rows = [
        ("Markup", "index.html", "Semantic HTML with a <template> for cards"),
        ("Styling", "styles.css", "CSS custom properties, grid layout, auto light/dark"),
        ("Logic", "app.js", "~165 lines of dependency-free vanilla JavaScript"),
        ("Data", "Gamma API", "Polymarket's public REST endpoint for markets"),
        ("Hosting", "Cloudflare Pages", "Static deploy — no build step, no server"),
    ]
    y = PAGE_H - MARGIN - 3.0 * cm
    rh = 1.85 * cm
    w = PAGE_W - 2 * MARGIN
    for label, name, desc in rows:
        c.setFillColor(PANEL)
        c.setStrokeColor(BORDER)
        c.roundRect(MARGIN, y - rh + 0.3 * cm, w, rh - 0.4 * cm, 0.3 * cm, fill=1, stroke=1)
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(MARGIN + 0.6 * cm, y - 0.6 * cm, label.upper())
        c.setFillColor(ACCENT)
        c.setFont("Courier-Bold", 14)
        c.drawString(MARGIN + 4.2 * cm, y - 0.62 * cm, name)
        c.setFillColor(TEXT)
        c.setFont("Helvetica", 12.5)
        c.drawString(MARGIN + 11.0 * cm, y - 0.62 * cm, desc)
        y -= rh
    footer(c, page_no)


def slide_closing(c):
    bg(c)
    c.setFillColor(PANEL)
    c.rect(0, PAGE_H * 0.30, PAGE_W, PAGE_H * 0.40, fill=1, stroke=0)
    c.setFillColor(ACCENT)
    c.circle(MARGIN + 0.25 * cm, PAGE_H * 0.585, 0.28 * cm, fill=1, stroke=0)
    c.setFillColor(TEXT)
    c.setFont("Helvetica-Bold", 38)
    c.drawString(MARGIN, PAGE_H * 0.49, "Thanks for watching")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 16)
    c.drawString(MARGIN, PAGE_H * 0.41,
                 "Browse the live app, or dive into the code: index.html · styles.css · app.js")
    c.setFillColor(ACCENT)
    c.setFont("Helvetica", 12)
    c.drawString(MARGIN, 3.0 * cm, "Disclaimer: not investment advice.")


def build(path):
    c = canvas.Canvas(path, pagesize=PAGE)
    c.setTitle("Polymarket Viewer — Project Overview")

    slide_title(c); c.showPage()
    slide_section(c, "The Problem",
                  "Why this exists",
                  ["Polymarket hosts thousands of live prediction markets, but scanning them quickly is hard.",
                   "Traders want a clean, at-a-glance view of what's hot right now — volume, odds, and deadlines.",
                   "Goal: a lightweight viewer that loads instantly and needs no account, no build, no backend."],
                  2); c.showPage()
    slide_features(c, 3); c.showPage()
    slide_flow(c, 4); c.showPage()
    slide_stack(c, 5); c.showPage()
    slide_section(c, "Design Choices",
                  "Why so simple?",
                  ["Zero dependencies — the entire app is three static files served as-is.",
                   "No framework means no build pipeline, tiny payload, and instant cold loads.",
                   "All filtering and sorting happen client-side for snappy, network-free interaction.",
                   "Theme follows the OS via prefers-color-scheme — no toggle to maintain."],
                  6); c.showPage()
    slide_section(c, "Roadmap",
                  "What's next",
                  ["Pagination / infinite scroll beyond the first 60 markets.",
                   "Category and tag filters (politics, crypto, sports).",
                   "Sparkline price history on each card.",
                   "Favourites saved to local storage.",
                   "Auto-refresh on an interval with a live indicator."],
                  7); c.showPage()
    slide_closing(c); c.showPage()

    c.save()
    print("Wrote", path)


if __name__ == "__main__":
    build("polymarket-viewer-presentation.pdf")
