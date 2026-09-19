#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
md2pdf.py — генерация PDF-копий Markdown-документов проекта.

Для каждого `*.md` в целевом каталоге (по умолчанию `docs/`) рядом создаётся
одноимённый `*.pdf` с тем же именем файла.

Поддерживаемое подмножество Markdown (то, что реально используется в docs/):
  * заголовки ATX (#..######), горизонтальные линейки (---);
  * абзацы, **жирный**, *курсив*, `моноширинный`, ссылки [текст](url);
  * таблицы GFM (в т.ч. с разметкой и картинками внутри ячеек);
  * маркированные и нумерованные списки с вложенностью;
  * цитаты (>) и fenced-блоки кода (```lang) с автоподбором кегля;
  * изображения ![alt](path): JPEG/PNG (Pillow) и SVG (svglib);
  * простая inline-математика $...$ ($z_2 = 150$, $\\ge$, $\\times$).

Зависимости (хватает virtualenv, системные пакеты не нужны):
    python3 -m venv .venv
    .venv/bin/pip install reportlab svglib pillow
Запуск:
    .venv/bin/python tools/md2pdf.py             # docs/*.md -> docs/*.pdf
    .venv/bin/python tools/md2pdf.py docs pcb    # несколько каталогов
    .venv/bin/python tools/md2pdf.py --check     # проверить актуальность PDF
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from itertools import count

from reportlab import platypus
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, StyleSheet1
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image as RLImage,
    PageTemplate,
    Paragraph,
    Table,
    TableStyle,
)
from reportlab.platypus.xpreformatted import XPreformatted

try:  # Pillow нужен для JPEG/PNG
    from PIL import Image as PILImage
except ImportError:  # pragma: no cover
    PILImage = None

try:  # svglib нужен для SVG-диаграмм
    from svglib.svglib import svg2rlg
except ImportError:  # pragma: no cover
    svg2rlg = None

# --------------------------------------------------------------------------- #
# Шрифты (кириллица) и цвета оформления
# --------------------------------------------------------------------------- #

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/DejaVu",
    "/usr/share/fonts/dejavu",
    "/usr/share/fonts/TTF",
    "/usr/local/share/fonts/dejavu",
    "/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "C:/Windows/Fonts",
]

FONT_FILES = {
    "Sans": "DejaVuSans.ttf",
    "Sans-Bold": "DejaVuSans-Bold.ttf",
    "Serif": "DejaVuSerif.ttf",
    "Serif-Bold": "DejaVuSerif-Bold.ttf",
    "Mono": "DejaVuSansMono.ttf",
    "Mono-Bold": "DejaVuSansMono-Bold.ttf",
}

ACCENT = colors.HexColor("#1f4e79")
CODE_BG = colors.HexColor("#f4f6f8")
CODE_BORDER = colors.HexColor("#c8d0d8")
QUOTE_BG = colors.HexColor("#fbf6e9")
QUOTE_BAR = colors.HexColor("#c8a54b")
GRAY = colors.HexColor("#595959")

# Имя зарегистрированного моноширинного шрифта (подставляется в <font face=...>)
MONO_FONT_NAME = "Courier"

# --------------------------------------------------------------------------- #
# Регулярные выражения разметки
# --------------------------------------------------------------------------- #

INLINE_RE = re.compile(
    r"(?P<code>`+(?P<code_text>.+?)`+)"
    r"|(?P<image>!\[(?P<img_alt>[^\]]*)\]\((?P<img_src>[^)\s]+)(?:\s+\"[^\"]*\")?\))"
    r"|(?P<link>\[(?P<link_text>[^\]]+)\]\((?P<link_href>[^)\s]+)(?:\s+\"[^\"]*\")?\))"
    r"|(?P<bold>\*\*(?P<bold_text>.+?)\*\*|__(?P<bold_text2>.+?)__)"
    r"|(?P<italic>(?<![\w*])\*(?P<italic_text>[^*\n]+?)\*(?![\w*])"
    r"|(?<![\w_])_(?P<italic_text2>[^_\n]+?)_(?![\w_]))"
    r"|(?P<math>\$(?P<math_text>[^$\n]+?)\$)",
    re.S,
)

IMAGE_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)(?:\s+\"[^\"]*\")?\)", re.S)

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
HR_RE = re.compile(r"^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$")
FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")

MATH_MACROS = {
    r"\ge": "≥",
    r"\geq": "≥",
    r"\le": "≤",
    r"\leq": "≤",
    r"\times": "×",
    r"\pm": "±",
    r"\approx": "≈",
    r"\cdot": "·",
    r"\to": "→",
    r"\rightarrow": "→",
    r"\Delta": "Δ",
    r"\pi": "π",
    r"\Omega": "Ω",
    r"\omega": "ω",
    r"\mu": "μ",
    r"\rho": "ρ",
    r"\circ": "°",
}

ALIGN_MAP = {"CENTER": TA_CENTER, "RIGHT": TA_RIGHT, "LEFT": TA_LEFT}


def register_fonts() -> dict:
    """Подключает TTF-шрифты DejaVu и возвращает карту имён семейств."""
    found = {}
    for family, filename in FONT_FILES.items():
        for folder in FONT_CANDIDATES:
            path = os.path.join(folder, filename)
            if os.path.isfile(path):
                found[family] = path
                break

    names = {}
    for family, path in found.items():
        name = "Doc" + family
        try:
            pdfmetrics.registerFont(TTFont(name, path))
            names[family] = name
        except Exception as exc:  # pragma: no cover
            print(f"  ! не удалось подключить {path}: {exc}", file=sys.stderr)

    if "Sans" not in names:
        print(
            "  ! шрифты DejaVu не найдены — кириллица в PDF может не отображаться\n"
            "    (установите, например, fonts-dejavu-core)",
            file=sys.stderr,
        )

    def get(family: str, fallback: str) -> str:
        return names.get(family, fallback)

    sans = get("Sans", "Helvetica")
    sans_bold = get("Sans-Bold", sans)
    serif = get("Serif", sans)
    serif_bold = get("Serif-Bold", sans_bold)
    mono = get("Mono", "Courier")
    mono_bold = get("Mono-Bold", mono)

    pdfmetrics.registerFontFamily(
        sans, normal=sans, bold=sans_bold, italic=serif, boldItalic=serif_bold
    )
    pdfmetrics.registerFontFamily(
        mono, normal=mono, bold=mono_bold, italic=mono, boldItalic=mono_bold
    )

    global MONO_FONT_NAME
    MONO_FONT_NAME = mono

    if svg2rlg is not None and "Sans" in found:
        try:  # кириллица внутри SVG: свой набор шрифтов DocSvgSans[-Bold]
            from svglib import fonts as svg_fonts

            fmap = svg_fonts.get_global_font_map()
            fmap.register_font("DocSvgSans", font_path=found["Sans"], rlgFontName="DocSvgSans")
            fmap.register_font(
                "DocSvgSans",
                font_path=found["Sans-Bold"],
                weight="bold",
                rlgFontName="DocSvgSans-Bold",
            )
            import svglib.svglib as _svg_mod

            _svg_mod.DEFAULT_FONT_NAME = "DocSvgSans"
        except Exception as exc:  # pragma: no cover
            print(f"  ! не удалось настроить шрифты SVG: {exc}", file=sys.stderr)

    return {"sans": sans, "sans_bold": sans_bold, "mono": mono, "serif": serif}


def build_styles(fonts: dict) -> StyleSheet1:
    sans, bold, mono, serif = (
        fonts["sans"],
        fonts["sans_bold"],
        fonts["mono"],
        fonts["serif"],
    )
    ss = StyleSheet1()

    for level, (size, lead) in enumerate(
        [(17, 21), (14, 18), (12, 15.5), (10.8, 14), (10.2, 13.2), (9.8, 12.6)],
        start=1,
    ):
        ss.add(
            ParagraphStyle(
                name=f"Heading{level}",
                fontName=bold,
                fontSize=size,
                leading=lead,
                textColor=ACCENT if level <= 3 else colors.HexColor("#2f4f6f"),
                spaceBefore=13 if level <= 2 else 9,
                spaceAfter=5,
                keepWithNext=1,
            )
        )
    ss.add(
        ParagraphStyle(
            name="Body",
            fontName=sans,
            fontSize=9.7,
            leading=13.6,
            alignment=TA_JUSTIFY,
            spaceAfter=6,
        )
    )
    ss.add(
        ParagraphStyle(
            name="ListItem",
            parent=ss["Body"],
            alignment=TA_LEFT,
            spaceAfter=2.5,
            spaceBefore=0.5,
        )
    )
    ss.add(
        ParagraphStyle(
            name="Code",
            fontName=mono,
            fontSize=8,
            leading=10,
            backColor=CODE_BG,
            borderColor=CODE_BORDER,
            borderWidth=0.7,
            borderPadding=6,
            spaceBefore=5,
            spaceAfter=9,
        )
    )
    ss.add(
        ParagraphStyle(
            name="TableCell",
            fontName=sans,
            fontSize=8.4,
            leading=10.8,
            alignment=TA_LEFT,
        )
    )
    ss.add(
        ParagraphStyle(
            name="TableHead",
            parent=ss["TableCell"],
            fontName=bold,
            textColor=colors.white,
        )
    )
    ss.add(
        ParagraphStyle(
            name="Missing",
            fontName=sans,
            fontSize=8.4,
            leading=11,
            alignment=TA_CENTER,
            textColor=GRAY,
        )
    )
    return ss


# --------------------------------------------------------------------------- #
# Инлайн-разметка: Markdown -> разметка reportlab
# --------------------------------------------------------------------------- #


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_angles(chunk: str) -> str:
    return chunk.replace("<", "&lt;").replace(">", "&gt;")


def _script(sign: str, body: str) -> str:
    tag = "sub" if sign == "_" else "super"
    return f"<{tag}>{body}</{tag}>"


def _math_markup(raw: str) -> str:
    """$z_2 = 150$ -> <i>z<sub>2</sub> = 150</i>, $\\ge$ -> ≥ и т.п."""
    text = raw.strip()
    for macro, repl in MATH_MACROS.items():
        text = text.replace(macro, repl)
    text = _escape(text)
    text = re.sub(r"([_^])\{([^{}]+)\}", lambda m: _script(m.group(1), m.group(2)), text)
    text = re.sub(r"([_^])(\w)", lambda m: _script(m.group(1), m.group(2)), text)
    return f"<i>{text}</i>"


def _protect_markup(text: str) -> str:
    """Экранирует «голые» &, <, >, не трогая уже проставленные теги."""
    known = {"amp", "lt", "gt", "quot", "apos"}
    text = re.sub(
        r"&([A-Za-z#][A-Za-z0-9]*);",
        lambda m: m.group(0) if m.group(1) in known or m.group(1).startswith("#") else "&amp;",
        text,
    )
    text = re.sub(r"&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)", "&amp;", text)

    out, pos = [], 0
    for match in re.finditer(r"</?[a-zA-Z][^>]*>", text):
        out.append(_escape_angles(text[pos : match.start()]))
        out.append(match.group(0))
        pos = match.end()
    out.append(_escape_angles(text[pos:]))
    return "".join(out)


def inline(text: str) -> str:
    """Строка Markdown -> строка разметки для Paragraph."""

    def repl(match: re.Match) -> str:
        if match.group("code"):
            return f'<font face="__MONO__">{_escape(match.group("code_text"))}</font>'
        if match.group("image"):
            alt = match.group("img_alt").strip()
            return _escape(alt) if alt else ""
        if match.group("link"):
            label = inline(match.group("link_text"))
            href = match.group("link_href").replace("&", "&amp;")
            return f'<link href="{href}" color="#1a5fb4"><u>{label}</u></link>'
        if match.group("bold"):
            body = match.group("bold_text") or match.group("bold_text2") or ""
            return f"<b>{inline(body)}</b>"
        if match.group("italic"):
            body = match.group("italic_text") or match.group("italic_text2") or ""
            return f"<i>{inline(body)}</i>"
        if match.group("math"):
            return _math_markup(match.group("math_text"))
        return _escape(match.group(0))

    out = _protect_markup(INLINE_RE.sub(repl, text))
    return out.replace("__MONO__", MONO_FONT_NAME)


# --------------------------------------------------------------------------- #
# Изображения
# --------------------------------------------------------------------------- #


def _placeholder(text: str, width: float, ss: StyleSheet1) -> Table:
    box = Paragraph(text, ss["Missing"])
    table = Table([[box]], colWidths=[width], rowHeights=[44])
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.8, CODE_BORDER),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fafafa")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table


class _DrawingWrapper(platypus.Flowable):
    """Обёртка над Drawing из svglib (чтобы вставить SVG как flowable)."""

    def __init__(self, drawing):
        super().__init__()
        self.drawing = drawing
        self.width = drawing.width
        self.height = drawing.height

    def wrap(self, avail_width, avail_height):
        return self.width, self.height

    def draw(self):
        self.drawing.drawOn(self.canv, 0, 0)


def image_flowable(src: str, base_dir: str, max_width: float, ss: StyleSheet1):
    """Картинка по пути из Markdown. Возвращает flowable (или заглушку)."""
    path = src if os.path.isabs(src) else os.path.normpath(os.path.join(base_dir, src))
    if not os.path.isfile(path):
        return _placeholder(f"Изображение недоступно: {_escape(src)}", max_width, ss)

    try:
        if path.lower().endswith(".svg"):
            if svg2rlg is None:
                raise RuntimeError("не установлен svglib")
            # svglib не наследует font-family со <svg> — проставляем её на <text>
            with open(path, encoding="utf-8") as handle:
                svg_text = handle.read()
            patched = re.sub(
                r"<text\b((?:(?!font-family=)[^>])*?)>",
                r'<text font-family="DocSvgSans"\1>',
                svg_text,
            )
            tmp_path = path
            if patched != svg_text:
                tmp_path = path + ".svgfont.tmp"
                with open(tmp_path, "w", encoding="utf-8") as handle:
                    handle.write(patched)
            try:
                drawing = svg2rlg(tmp_path)
            finally:
                if tmp_path != path and os.path.isfile(tmp_path):
                    os.remove(tmp_path)
            if drawing is None:
                raise RuntimeError("svglib не разобрал файл")
            scale = min(1.4, max_width / drawing.width) if drawing.width else 1.0
            drawing.scale(scale, scale)
            drawing.width *= scale
            drawing.height *= scale
            return _DrawingWrapper(drawing)
        if PILImage is None:
            raise RuntimeError("не установлен Pillow")
        with PILImage.open(path) as img:
            width, height = img.size
        if width <= 0 or height <= 0:
            raise RuntimeError("нулевой размер изображения")
        target_w = min(float(width), max_width)
        return RLImage(path, width=target_w, height=height * target_w / width)
    except Exception as exc:
        return _placeholder(
            f"Не удалось вставить {_escape(src)}: {_escape(str(exc))}", max_width, ss
        )


# --------------------------------------------------------------------------- #
# Таблицы GFM
# --------------------------------------------------------------------------- #


def split_row(line: str):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells, buf, escaped = [], [], False
    for ch in line:
        if escaped:
            buf.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == "|":
            cells.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    cells.append("".join(buf).strip())
    return [c.replace("\\|", "|") for c in cells]


def alignments(sep_row: str):
    result = []
    for cell in split_row(sep_row):
        left, right = cell.startswith(":"), cell.endswith(":")
        result.append("CENTER" if left and right else "RIGHT" if right else "LEFT")
    return result


def _token_metrics(text: str, sans: str) -> tuple:
    """(ширина самого широкого неделимого токена, суммарная ширина текста).

    Токены в `обратных кавычках` считаются неделимыми и считаются
    моноширинным шрифтом; ссылки сводим к видимому тексту.
    """
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[*_$]", "", text)
    space = pdfmetrics.stringWidth(" ", sans, 8.4)
    max_tok, total, count = 0.0, 0.0, 0
    for match in re.finditer(r"`([^`]+)`|(\S+)", text):
        token = match.group(1) or match.group(2)
        font = MONO_FONT_NAME if match.group(1) else sans
        width = pdfmetrics.stringWidth(token, font, 8.4)
        max_tok = max(max_tok, width)
        total += width
        count += 1
    total += space * max(count - 1, 0)
    return max_tok, total


def _column_widths(rows, avail_width: float, sans: str):
    n_cols = len(rows[0])
    mins, desired = [], []
    for col in range(n_cols):
        body = [rows[i][col] for i in range(1, len(rows))] or [rows[0][col]]
        metrics = [_token_metrics(c, sans) for c in body]
        head_max, head_total = _token_metrics(rows[0][col], sans)
        col_min = max([m[0] for m in metrics] + [head_max]) + 10
        col_sum = max([m[1] for m in metrics] + [head_total]) + 10
        if any(IMAGE_RE.search(r[col]) for r in rows):
            col_min = max(col_min, 118)
        mins.append(min(col_min, avail_width * 0.62))
        desired.append(max(min(col_sum, avail_width * 0.62), 20))

    weights = [d + m * 0.5 for d, m in zip(desired, mins)]
    widths = [avail_width * w / sum(weights) for w in weights]

    # гарантируем, что самый длинный токен не будет разорван
    deficit = sum(max(0.0, mins[i] - widths[i]) for i in range(n_cols))
    widths = [max(widths[i], mins[i]) for i in range(n_cols)]
    donors = [i for i in range(n_cols) if widths[i] > mins[i]]
    donor_total = sum(widths[i] for i in donors) or 1.0
    for i in donors:
        widths[i] -= deficit * widths[i] / donor_total

    scale = avail_width / sum(widths)
    return [w * scale for w in widths]


def _aligned_style(style: ParagraphStyle, align: str) -> ParagraphStyle:
    if ALIGN_MAP.get(align, TA_LEFT) == style.alignment:
        return style
    return ParagraphStyle(
        name=f"{style.name}-{align}", parent=style, alignment=ALIGN_MAP.get(align, TA_LEFT)
    )


def _cell_flowables(raw: str, inner_w: float, base_dir: str, ss: StyleSheet1, header: bool):
    if not IMAGE_RE.search(raw):
        style = ss["TableHead"] if header else ss["TableCell"]
        return Paragraph(inline(raw) or "&nbsp;", style)

    parts, pos = [], 0
    for match in IMAGE_RE.finditer(raw):
        before = raw[pos : match.start()].strip()
        if before:
            parts.append(Paragraph(inline(before), ss["TableCell"]))
        flow = image_flowable(match.group("src"), base_dir, inner_w, ss)
        flow.hAlign = "CENTER"
        parts.append(flow)
        pos = match.end()
    after = raw[pos:].strip()
    if after:
        parts.append(Paragraph(inline(after), ss["TableCell"]))
    return parts or [Paragraph("&nbsp;", ss["TableCell"])]


def build_table(rows, aligns, avail_width: float, base_dir: str, ss: StyleSheet1) -> Table:
    n_cols = max(len(r) for r in rows)
    rows = [r + [""] * (n_cols - len(r)) for r in rows]
    aligns = (aligns + ["LEFT"] * n_cols)[:n_cols]
    widths = _column_widths(rows, avail_width, ss["TableCell"].fontName)

    data = [
        [
            _cell_flowables(row[c], widths[c] - 8, base_dir, ss, header=(r == 0))
            for c in range(n_cols)
        ]
        for r, row in enumerate(rows)
    ]
    # выравнивание по :---: применяем к абзацам ячеек (картинки центрируются сами)
    for r in range(len(data)):
        for c in range(n_cols):
            cell = data[r][c]
            if isinstance(cell, Paragraph):
                data[r][c] = Paragraph(cell.text, _aligned_style(cell.style, aligns[c]))

    table = Table(data, colWidths=widths, repeatRows=1, hAlign="CENTER")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9fb3c8")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [colors.white, colors.HexColor("#f2f6fa")],
                ),
            ]
        )
    )
    table.spaceBefore = 4
    table.spaceAfter = 10
    return table


# --------------------------------------------------------------------------- #
# Разбор блоков Markdown
# --------------------------------------------------------------------------- #


def parse_markdown(text: str, base_dir: str, ss: StyleSheet1, avail_width: float):
    lines = text.replace("\r\n", "\n").replace("\t", "    ").split("\n")
    return _blocks(lines, 0, len(lines), base_dir, ss, avail_width)


def _code_block(body, ss: StyleSheet1, avail_width: float) -> XPreformatted:
    """Fenced-блок: кегль подбирается так, чтобы самые длинные строки влезали."""
    text = "\n".join(body).rstrip("\n")
    longest = max((len(ln) for ln in text.split("\n")), default=1)
    size = min(8.2, (avail_width - 20) / max(longest * 0.602, 1.0))
    size = max(size, 5.4)
    style = ParagraphStyle(
        name="CodeAuto", parent=ss["Code"], fontSize=size, leading=size * 1.28
    )
    return XPreformatted(_escape(text), style)


def _list_flows(items, pos, base_dir, ss: StyleSheet1):
    """Список -> абзацы с маркерами (вложенность через отступ)."""
    flows = []
    bullets = ["\u2022", "\u2013", "\u25e6", "\u00b7"]
    stack = []  # [отступ, нумерованный?, текущий номер]
    while pos < len(items):
        ind, marker, content = items[pos]
        pos += 1
        while stack and ind < stack[-1][0]:
            stack.pop()
        if not stack or ind > stack[-1][0]:
            ordered = bool(re.match(r"\d", marker))
            stack.append([ind, ordered, int(re.match(r"\d+", marker).group(0)) if ordered else 0])
        elif stack[-1][1]:
            stack[-1][2] += 1

        depth = len(stack) - 1
        bullet = f"{stack[-1][2]}." if stack[-1][1] else bullets[min(depth, len(bullets) - 1)]
        style = ParagraphStyle(
            name=f"ListItem-d{depth}",
            parent=ss["ListItem"],
            leftIndent=15 + 14 * depth,
            firstLineIndent=-11,
            bulletIndent=2 + 14 * depth,
        )
        flows.append(Paragraph(inline(" ".join(content)), style, bulletText=bullet))
    return flows, pos


def _blocks(lines, start, end, base_dir, ss: StyleSheet1, avail_width: float):
    flowables = []
    i = start
    while i < end:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # --- fenced-блок кода
        if FENCE_RE.match(line):
            body = []
            i += 1
            while i < end and not re.match(r"^\s{0,3}(`{3,}|~{3,})\s*$", lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            flowables.append(_code_block(body, ss, avail_width))
            continue

        # --- заголовок
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            flowables.append(Paragraph(inline(heading.group(2).strip()), ss[f"Heading{level}"]))
            i += 1
            continue

        # --- горизонтальная линейка
        if HR_RE.match(line):
            flowables.append(
                HRFlowable(
                    width="100%",
                    thickness=0.8,
                    color=colors.HexColor("#b9c6d4"),
                    spaceBefore=6,
                    spaceAfter=8,
                )
            )
            i += 1
            continue

        # --- таблица GFM
        if stripped.startswith("|") and i + 1 < end and TABLE_SEP_RE.match(lines[i + 1]):
            rows = [split_row(line)]
            aligns = alignments(lines[i + 1])
            i += 2
            while i < end and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i]))
                i += 1
            flowables.append(build_table(rows, aligns, avail_width, base_dir, ss))
            continue

        # --- цитата
        if stripped.startswith(">"):
            body = []
            while i < end and (lines[i].strip().startswith(">") or (body and stripped)):
                body.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
                if i < end and not lines[i].strip():
                    break
            inner = _blocks(body, 0, len(body), base_dir, ss, avail_width - 20)
            quote = Table([[inner]], colWidths=[avail_width])
            quote.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), QUOTE_BG),
                        ("LINEBEFORE", (0, 0), (0, -1), 3, QUOTE_BAR),
                        ("LEFTPADDING", (0, 0), (-1, -1), 10),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                        ("TOPPADDING", (0, 0), (-1, -1), 6),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ]
                )
            )
            quote.spaceAfter = 9
            flowables.append(quote)
            continue

        # --- список
        if LIST_RE.match(line):
            items = []
            while i < end:
                match = LIST_RE.match(lines[i])
                if match:
                    items.append(
                        [len(match.group(1)), match.group(2), [match.group(3)]]
                    )
                    i += 1
                    continue
                if lines[i].strip() and items and lines[i].startswith(" "):
                    items[-1][2].append(lines[i].strip())
                    i += 1
                    continue
                break
            list_flows, _ = _list_flows(items, 0, base_dir, ss)
            flowables.extend(list_flows)
            continue

        # --- одиночное изображение
        only_image = IMAGE_RE.fullmatch(stripped)
        if only_image:
            flow = image_flowable(
                only_image.group("src"), base_dir, avail_width * 0.82, ss
            )
            flow.hAlign = "CENTER"
            flowables.append(flow)
            i += 1
            continue

        # --- абзац (склеиваем перенесённые строки)
        para = [stripped]
        i += 1
        while i < end:
            nxt = lines[i]
            if (
                not nxt.strip()
                or HEADING_RE.match(nxt)
                or HR_RE.match(nxt)
                or FENCE_RE.match(nxt)
                or LIST_RE.match(nxt)
                or nxt.strip().startswith("|")
                or nxt.strip().startswith(">")
                or IMAGE_RE.fullmatch(nxt.strip())
            ):
                break
            para.append(nxt.strip())
            i += 1
        flowables.append(Paragraph(inline(" ".join(para)), ss["Body"]))

    return flowables


# --------------------------------------------------------------------------- #
# Шаблон документа: колонтитулы, метаданные, закладки
# --------------------------------------------------------------------------- #


class DocTemplate(BaseDocTemplate):
    def __init__(self, filename, doc_title, source, fonts=None, **kwargs):
        self.doc_title = doc_title
        self.doc_source = source
        self.header_font = (fonts or {}).get("sans", "Helvetica")
        self._bookmarks = count(1)
        super().__init__(filename, title=doc_title, **kwargs)
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="page", frames=[frame], onPage=self._decorate))

    def _decorate(self, canv, doc):
        canv.saveState()
        width, height = A4
        if canv.getPageNumber() > 1:
            canv.setFont(self.header_font, 7.6)
            canv.setFillColor(GRAY)
            canv.drawString(doc.leftMargin, height - 13 * mm, self.doc_title[:92])
            canv.setStrokeColor(colors.HexColor("#d7dee6"))
            canv.setLineWidth(0.5)
            canv.line(doc.leftMargin, height - 14.5 * mm, width - doc.rightMargin, height - 14.5 * mm)
        canv.setStrokeColor(colors.HexColor("#d7dee6"))
        canv.setLineWidth(0.5)
        canv.line(doc.leftMargin, 13 * mm, width - doc.rightMargin, 13 * mm)
        canv.setFont(self.header_font, 7.6)
        canv.setFillColor(GRAY)
        canv.drawString(doc.leftMargin, 9.5 * mm, self.doc_source)
        canv.drawRightString(width - doc.rightMargin, 9.5 * mm, f"Стр. {canv.getPageNumber()}")
        canv.restoreState()

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        match = re.match(r"Heading([1-6])$", flowable.style.name)
        if not match:
            return
        level = min(int(match.group(1)) - 1, 4)
        key = f"h{next(self._bookmarks)}"
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(
            flowable.getPlainText()[:120], key, level=level, closed=level > 0
        )


def convert(md_path: str, pdf_path: str, fonts: dict, ss: StyleSheet1) -> int:
    """Собирает PDF рядом с Markdown; возвращает число страниц."""
    with open(md_path, encoding="utf-8") as handle:
        text = handle.read()

    match = re.search(r"^#\s+(.+)$", text, re.M)
    title = match.group(1).strip() if match else os.path.splitext(os.path.basename(md_path))[0]
    title = re.sub(r"[*_`]", "", title)

    doc = DocTemplate(
        pdf_path,
        doc_title=title,
        source=os.path.relpath(
            os.path.abspath(md_path),
            os.path.dirname(os.path.dirname(os.path.abspath(md_path))),
        ),
        fonts=fonts,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
        author="rus_slam",
        subject=f"PDF-копия {os.path.basename(md_path)}",
        creator="tools/md2pdf.py (reportlab)",
    )
    flowables = parse_markdown(
        text, os.path.dirname(os.path.abspath(md_path)), ss, doc.width
    )
    doc.build(flowables)
    return doc.page


def collect_targets(paths):
    targets = []
    for path in paths:
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if name.lower().endswith(".md"):
                    targets.append(os.path.join(path, name))
        elif path.lower().endswith(".md"):
            targets.append(path)
    return targets


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Markdown -> PDF: дублирует .md-документацию в .pdf"
    )
    parser.add_argument(
        "paths", nargs="*", default=["docs"], help="каталоги или файлы .md (по умолчанию docs)"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="не собирать, а проверить, что PDF существует и новее исходного .md",
    )
    args = parser.parse_args(argv)

    targets = collect_targets(args.paths or ["docs"])
    if not targets:
        print("Markdown-файлы не найдены.", file=sys.stderr)
        return 1

    if args.check:
        stale = []
        for md in targets:
            pdf = os.path.splitext(md)[0] + ".pdf"
            if not os.path.isfile(pdf) or os.path.getmtime(pdf) < os.path.getmtime(md):
                stale.append(md)
        if stale:
            print("PDF не актуальны: " + ", ".join(stale))
            return 1
        print(f"PDF актуальны для {len(targets)} файл(ов).")
        return 0

    fonts = register_fonts()
    ss = build_styles(fonts)

    failed = 0
    for md in targets:
        pdf = os.path.splitext(md)[0] + ".pdf"
        try:
            pages = convert(md, pdf, fonts, ss)
            size_kb = os.path.getsize(pdf) / 1024
            print(f"  {md} -> {pdf}  ({pages} стр., {size_kb:.0f} КБ)")
        except Exception as exc:
            failed += 1
            print(f"  ! {md}: {type(exc).__name__}: {exc}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
