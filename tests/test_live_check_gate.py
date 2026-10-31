import subprocess
from pathlib import Path

import pytest

GATE = Path(__file__).resolve().parents[1] / "scripts" / "live-check-gate"
DRIVER = "src/auto24_service/mnt_lookup.py\nREADME.md\n"


def run_gate(paths, body="", labels=""):
    return subprocess.run(
        [str(GATE)],
        input=paths,
        text=True,
        capture_output=True,
        env={"PATH": "/usr/bin:/bin", "PR_BODY": body, "PR_LABELS": labels},
    ).returncode


@pytest.mark.parametrize(
    "path",
    [
        "src/auto24_service/browser_chromium.py",
        "src/auto24_service/captcha/reveal.py",
        "scripts/captcharaptor/background.js",
        "Dockerfile.invisible",
    ],
)
def test_driver_change_without_a_live_check_fails(path):
    assert run_gate(path + "\n") == 1


def test_changes_outside_the_drivers_pass():
    assert run_gate("README.md\nsrc/auto24_service/budget.py\n") == 0


@pytest.mark.parametrize(
    "body",
    ["Live check: listing 3758653, PDF saved", "- **Live check:** 3 of 3 plates returned a PDF"],
)
def test_a_filled_live_check_line_passes(body):
    assert run_gate(DRIVER, body=f"## Evidence\n{body}\n") == 0


@pytest.mark.parametrize(
    "body",
    [
        "Live check: none",
        "Live check: N/A",
        "Live check:",
        "Live check: pending",
        "Live checklist: pending",
        "Live check listing 3758653, PDF saved",
        "- **Live check:** pending",
    ],
)
def test_an_empty_live_check_line_fails(body):
    assert run_gate(DRIVER, body=body) == 1


def test_the_live_verified_label_passes():
    assert run_gate(DRIVER, labels="bug\nlive-verified") == 0
