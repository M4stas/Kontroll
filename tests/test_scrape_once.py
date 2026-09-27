import json
from pathlib import Path

import pytest

from auto24_service import scrape_once as cli
from auto24_service.parser import ParseError


LISTING_URL = "https://www.auto24.ee/soidukid/4344096"
FIXTURE = Path(__file__).parent / "fixtures" / "auto24-passenger-car.html"


def test_valid_url_prints_parsed_listing_with_utc_timestamp(monkeypatch, capsys):
    monkeypatch.setattr(cli, "capture_html", lambda url: FIXTURE.read_text(encoding="utf-8"))

    exit_code = cli.main([LISTING_URL])

    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert exit_code == 0
    assert captured.err == ""
    assert result["listing_id"] == "4344096"
    assert result["title"] == "Skoda Enyaq 195kW"
    assert result["parsed_at"].endswith("Z")
    assert "warnings" in result


def test_invalid_url_returns_json_error_on_stderr(monkeypatch, capsys):
    monkeypatch.setattr(cli, "capture_html", lambda url: pytest.fail("invalid URL reached browser"))

    exit_code = cli.main(["https://example.org/soidukid/4344096"])

    captured = capsys.readouterr()
    error = json.loads(captured.err)
    assert exit_code != 0
    assert captured.out == ""
    assert error["error"]["code"] == "access_blocked"


@pytest.mark.parametrize("code", ["listing_gone", "access_blocked"])
def test_capture_errors_are_returned_as_typed_json(monkeypatch, capsys, code):
    def fail_capture(_url):
        raise cli.ScrapeError(code, code.replace("_", " "))

    monkeypatch.setattr(cli, "capture_html", fail_capture)

    exit_code = cli.main([LISTING_URL])

    captured = capsys.readouterr()
    error = json.loads(captured.err)
    assert exit_code != 0
    assert captured.out == ""
    assert error["error"]["code"] == code


def test_unsupported_vehicle_error_is_returned_as_typed_json(monkeypatch, capsys):
    html = '<h1>Delivery van</h1><table class="main-data"><tr><td class="label">Liik</td><td class="value">kaubik</td></tr></table>'
    monkeypatch.setattr(cli, "capture_html", lambda url: html)

    exit_code = cli.main([LISTING_URL])

    captured = capsys.readouterr()
    error = json.loads(captured.err)
    assert exit_code != 0
    assert error["error"]["code"] == "unsupported_vehicle_type"


def test_parse_failure_is_returned_as_typed_json(monkeypatch, capsys):
    monkeypatch.setattr(cli, "capture_html", lambda url: "<main>not a listing</main>")

    exit_code = cli.main([LISTING_URL])

    captured = capsys.readouterr()
    error = json.loads(captured.err)
    assert exit_code != 0
    assert error["error"]["code"] == "parse_failed"


def test_cli_can_be_called_with_an_injected_capture_function():
    result = cli.scrape_once(
        LISTING_URL,
        capture=lambda url: FIXTURE.read_text(encoding="utf-8"),
    )

    assert result["source_url"] == LISTING_URL
    assert result["listing_id"] == "4344096"
