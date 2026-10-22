"""The background check PDF check. Fake PDFs and fake values only."""

import pytest

import time

from auto24_service.pdf_check import MAX_PDF_BYTES, pdf_matches, pdf_text
from tests.fakesite.pdf import identity_pdf, plain_pdf


REG = "123ABC"
VIN = "WVWZZZ1KZAW000001"
# iText writes each label and each value as a text string of its own, as in the recon PDF.
LINES = ["Sõiduki taustakontroll", "Registreerimismärk", REG, "VIN-kood", VIN, "Mark (näide)"]


@pytest.mark.parametrize("build", [plain_pdf, identity_pdf])
def test_pdf_text_reads_plain_and_identity_encoded_text(build):
    text = pdf_text(build(LINES))
    for line in LINES:
        assert line in text


@pytest.mark.parametrize("build", [plain_pdf, identity_pdf])
def test_pdf_matches_the_searched_value(build):
    pdf = build(LINES)
    assert pdf_matches(pdf, REG)
    assert pdf_matches(pdf, VIN)
    assert pdf_matches(pdf, "123 abc")


@pytest.mark.parametrize("build", [plain_pdf, identity_pdf])
def test_pdf_for_another_car_does_not_match(build):
    pdf = build(["Registreerimismärk", "456DEF", "VIN-kood", "WVWZZZ1KZAW000002"])
    assert not pdf_matches(pdf, REG)
    assert not pdf_matches(pdf, VIN)


def test_non_pdf_and_oversized_files_never_match():
    assert not pdf_matches(b"<html>" + REG.encode() + b"</html>", REG)
    assert not pdf_matches(b"", REG)
    big = plain_pdf(LINES)
    assert not pdf_matches(big + b"\0" * (MAX_PDF_BYTES - len(big) + 1), REG)
    assert MAX_PDF_BYTES == 12 * 1024 * 1024


def test_value_in_raw_bytes_outside_the_text_does_not_match():
    pdf = plain_pdf(["Taustakontroll"]).replace(b"%PDF-1.4\n", b"%PDF-1.4\n% " + REG.encode() + b"\n", 1)
    assert not pdf_matches(pdf, REG)


def test_broken_streams_do_not_raise():
    pdf = b"%PDF-1.4\nstream\nnot zlib\nendstream\n(unbalanced \\"
    assert pdf_text(pdf) == ""
    assert not pdf_matches(pdf, REG)


@pytest.mark.parametrize("build", [plain_pdf, identity_pdf])
def test_value_must_be_a_whole_text_string(build):
    pdf = build(["Registreerimismärk", "456DEF", "Mark", "VW GOLF (näide)", "Registreerimismärk 789GHI"])
    for value in ("456", "DEF", "GOLF", "789GHI"):
        assert not pdf_matches(pdf, value), value
    assert pdf_matches(pdf, "456 def")


def _cmap_pdf(cmaps: list[bytes]) -> bytes:
    from tests.fakesite.pdf import _document, _stream
    return _document([b"<< /Type /Catalog >>", _stream(b"BT (x) Tj ET"), *(_stream(c) for c in cmaps)])


def test_unicode_ranges_are_capped_in_one_map():
    ranges = b"".join(b"<%04X> <FFFF> <0041>\n" % low for low in range(0, 4000))
    cmap = b"4000 beginbfrange\n" + ranges + b"endbfrange\n1 beginbfrange\n<10000> <1FFFF> <0041>\nendbfrange\n"
    started = time.monotonic()
    assert pdf_text(_cmap_pdf([cmap])) == "x"
    assert time.monotonic() - started < 2  # uncapped, this took over 20 s


def test_unicode_ranges_are_capped_across_maps():
    # Distinct full-range maps; uncapped, 40 of them took about 350 MB.
    import tracemalloc
    cmaps = [b"1 beginbfrange\n<0000> <FFFF> <%04X>\nendbfrange\n" % (0x41 + i) for i in range(40)]
    tracemalloc.start()
    try:
        assert pdf_text(_cmap_pdf(cmaps)).startswith("x")
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert peak < 64 * 1024 * 1024
