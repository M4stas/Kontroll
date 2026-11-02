import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci-docs-only"


@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        ("", "false"),
        ("docs/guide.md\n", "true"),
        ("README.md\n", "true"),
        ("other/guide.md\n", "false"),
        ("docs/guide.md\nsrc/app.ts\n", "false"),
        (".github/workflows/ci.yml\n", "false"),
        (".no-mistakes.yaml\n", "true"),
        ("docs/renamed.md\nsrc/previous.ts\n", "false"),
        ("docs/superpowers/roadmap.md\n", "false"),
    ],
)
def test_docs_only(paths, expected):
    result = subprocess.run([str(SCRIPT)], input=paths, text=True, capture_output=True, check=True)
    assert result.stdout == f"docs_only={expected}\n"
