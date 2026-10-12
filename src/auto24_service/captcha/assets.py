"""Read and check the pinned CaptchaRaptor solver data files."""

import hashlib
from collections.abc import Mapping
from pathlib import Path

# The solver files the package accepts, pinned here so a solver directory cannot
# vouch for itself. tests/test_solver_assets.py keeps this equal to
# vendor/captcha-solver/SHA256SUMS.
PINNED_SOLVER_SHA256: Mapping[str, str] = {
    "type.onnx": "3d48dc93d0b1fb3e399096eeaa387f0877a939b0ea0a824a703865234c0a6f0b",
    "grid.onnx": "19afc4fb06af9a20bc920fd728cf556def069a2af8a7760f919fd825c8369e64",
    "grid.meta.json": "d5b788706dca5401564656ab25ccae37898ff4aed96c5b2fb902dd32b4c1df49",
    "captcha.sqlite": "7689a67eda67fdf242c6eefd23994325d4982c9b66f40fdaad498a1af9a6da08",
}


class SolverFilesError(RuntimeError):
    """A solver file is missing or does not match its pinned hash."""


def read_sums(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            digest, name = line.split(maxsplit=1)
        except ValueError:
            raise SolverFilesError(f"malformed line {number} in {path.name}") from None
        entries[name.lstrip("*")] = digest
    return entries


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_solver_dir(solver_dir: Path) -> None:
    """Check every pinned file against PINNED_SOLVER_SHA256.

    A SHA256SUMS file in the directory, when present, must list exactly the pinned
    files and hashes; it is never the source of truth.
    """
    pinned = dict(PINNED_SOLVER_SHA256)
    sums = solver_dir / "SHA256SUMS"
    if sums.exists() and read_sums(sums) != pinned:
        raise SolverFilesError("SHA256SUMS does not match the pinned solver hashes")
    for name, expected in pinned.items():
        path = solver_dir / name
        if not path.is_file():
            raise SolverFilesError(f"solver file missing: {name}")
        if sha256_file(path) != expected:
            raise SolverFilesError(f"solver file hash mismatch: {name}")
