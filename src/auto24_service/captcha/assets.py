"""Read and check the pinned CaptchaRaptor solver data files."""

import hashlib
from pathlib import Path


class SolverFilesError(RuntimeError):
    """A solver file is missing or does not match its pinned hash."""


def read_sums(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        digest, name = line.split(maxsplit=1)
        entries[name.lstrip("*")] = digest
    return entries


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_solver_dir(solver_dir: Path, sums: Path) -> None:
    for name, expected in read_sums(sums).items():
        path = solver_dir / name
        if not path.is_file():
            raise SolverFilesError(f"solver file missing: {name}")
        if sha256_file(path) != expected:
            raise SolverFilesError(f"solver file hash mismatch: {name}")
