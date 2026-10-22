"""The background check PDF check. Fake PDFs and fake values only."""

import pytest

from auto24_service.pdf_check import MAX_PDF_BYTES, pdf_matches, pdf_text
from tests.fake_pdf import identity_pdf, plain_pdf


REG = "123ABC"
VIN = "WVWZZZ1KZAW000001"
LINES = ["Sõiduki taustakontroll", f"Registreerimismärk {REG}", f"VIN-kood {VIN}", "Mark (näide)"]


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
    pdf = build(["Registreerimismärk 456DEF", "VIN-kood WVWZZZ1KZAW000002"])
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
