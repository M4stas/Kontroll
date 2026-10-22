"""Check a downloaded background check PDF before the service keeps it (spec decision 8).

Transpordiamet's PDFs come from iText with subset fonts, so the text is two-byte glyph
codes mapped through ToUnicode tables. This reads only what the check needs: text-show
strings, decoded as Latin-1 and through each ToUnicode table. It never raises.
"""

from __future__ import annotations

import re
import zlib

MAX_PDF_BYTES = 12 * 1024 * 1024  # the upload form's MAX_PDF_SIZE
_MAX_INFLATED_BYTES = 64 * 1024 * 1024
_MAX_CODE = 0xFFFF
_STREAM = re.compile(rb"stream\r?\n(.*?)\r?\nendstream", re.S)
_LITERAL = rb"\(((?:\\.|[^\\)])*)\)"
_SHOW = re.compile(_LITERAL + rb"\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ", re.S)
_ESCAPES = {ord("n"): b"\n", ord("r"): b"\r", ord("t"): b"\t", ord("b"): b"\b", ord("f"): b"\f"}


def _unescape(raw: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(raw):
        if raw[i] == 0x5C and i + 1 < len(raw):
            octal = re.match(rb"[0-7]{1,3}", raw[i + 1:i + 4])
            if octal:
                out.append(int(octal.group(), 8) & 0xFF)
                i += 1 + len(octal.group())
                continue
            out += _ESCAPES.get(raw[i + 1], raw[i + 1:i + 2])
            i += 2
            continue
        out.append(raw[i])
        i += 1
    return bytes(out)


def _streams(pdf: bytes) -> list[bytes]:
    streams, budget = [], _MAX_INFLATED_BYTES
    for raw in _STREAM.findall(pdf):
        if budget <= 0:
            break
        try:
            data = zlib.decompressobj().decompress(raw, budget)
        except zlib.error:
            continue
        budget -= len(data)
        streams.append(data)
    return streams


def _unicode_map(cmap: bytes, budget: list[int]) -> dict[int, str]:
    """`budget` holds the codes left for every map of the PDF together."""
    table: dict[int, str] = {}
    # Two-byte codes only, and at most one pass over them in all maps together.
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", cmap, re.S):
        for source, target in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            if budget[0] <= 0:
                return {code: char for code, char in table.items() if code <= _MAX_CODE}
            table[int(source, 16)] = bytes.fromhex(target.decode()).decode("utf-16-be", "replace")
            budget[0] -= 1
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", cmap, re.S):
        for low, high, target in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            start, first = int(low, 16), int(target, 16)
            stop = min(int(high, 16), _MAX_CODE, start + budget[0] - 1)
            for code in range(start, stop + 1):
                table[code] = chr(min(first + code - start, 0x10FFFF))
            budget[0] -= max(0, stop - start + 1)
            if budget[0] <= 0:
                return {code: char for code, char in table.items() if code <= _MAX_CODE}
    return {code: char for code, char in table.items() if code <= _MAX_CODE}


def pdf_text(pdf: bytes) -> str:
    """Every text-show string, once as Latin-1 and once through each ToUnicode table."""
    try:
        streams = _streams(pdf)
        budget = [_MAX_CODE + 1]
        cmaps = dict.fromkeys(s for s in streams if b"beginbfchar" in s or b"beginbfrange" in s)
        maps = [_unicode_map(cmap, budget) for cmap in cmaps]
        pieces: list[str] = []
        for stream in streams:
            for single, array in _SHOW.findall(stream):
                strings = [single] if single else re.findall(_LITERAL, array)
                for raw in strings:
                    data = _unescape(raw)
                    pieces.append(data.decode("latin-1"))
                    if len(data) % 2 == 0:
                        codes = [int.from_bytes(data[i:i + 2], "big") for i in range(0, len(data), 2)]
                        # An unknown code stays a gap, so another font's map cannot spell the value.
                        pieces.extend("".join(m.get(c, "\ufffd") for c in codes) for m in maps)
        return "\n".join(p for p in pieces if p)
    except Exception:
        return ""


def _normal(text: str) -> str:
    return "".join(text.split()).casefold()


def pdf_matches(pdf: bytes, value: str) -> bool:
    """True for a PDF of at most 12 MB with a text string equal to the searched value.

    iText writes each value as a text string of its own, so a whole-string match keeps
    a short value from matching part of a label or of another car's number.
    """
    if not pdf.startswith(b"%PDF-") or len(pdf) > MAX_PDF_BYTES or not value.strip():
        return False
    return any(_normal(value) == _normal(line) for line in pdf_text(pdf).splitlines())
