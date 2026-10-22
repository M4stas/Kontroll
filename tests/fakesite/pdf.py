"""Build small fake PDFs for background check tests. All text in them is made up."""

from __future__ import annotations

import zlib


def _escape(data: bytes) -> bytes:
    return data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _document(objects: list[bytes]) -> bytes:
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def _stream(data: bytes, compress: bool = True) -> bytes:
    if compress:
        data = zlib.compress(data)
        return b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream"
    return b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def plain_pdf(lines: list[str]) -> bytes:
    """One page of Helvetica text, one Tj per line."""
    content = b"BT /F1 11 Tf 50 780 Td 14 TL\n" + b"".join(
        b"(" + _escape(line.encode("latin-1")) + b") Tj T*\n" for line in lines
    ) + b"ET"
    return _document([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        _stream(content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])


def identity_pdf(lines: list[str]) -> bytes:
    """Text as two-byte glyph codes with a ToUnicode map, as iText writes subset fonts."""
    chars = sorted({c for line in lines for c in line})
    code = {c: i + 3 for i, c in enumerate(chars)}
    content = b"BT /F1 11 Tf 50 780 Td 14 TL\n" + b"".join(
        b"(" + _escape(b"".join(code[c].to_bytes(2, "big") for c in line)) + b") Tj T*\n"
        for line in lines
    ) + b"ET"
    cmap = (
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        b"1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
        + b"%d beginbfchar\n" % len(chars)
        + b"".join(b"<%04X> <%s>\n" % (code[c], c.encode("utf-16-be").hex().upper().encode()) for c in chars)
        + b"endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end"
    )
    return _document([
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        _stream(content),
        b"<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+ArialMT /Encoding /Identity-H "
        b"/DescendantFonts [] /ToUnicode 6 0 R >>",
        _stream(cmap),
    ])
