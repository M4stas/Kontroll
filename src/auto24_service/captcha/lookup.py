"""Read-only hash lookup table (captcha.sqlite)."""

import sqlite3
from pathlib import Path

from .assets import SolverFilesError
from .phash import hamming

MAX_DISTANCE = 9
_BANDS = ("band0", "band1", "band2", "band3")
_PAIRS = [(i, j) for i in range(4) for j in range(i + 1, 4)]
_SCHEMA = {
    "phash33": {"label", "phash", "selected", *_BANDS},
    "phash44": {"label", "phash", "mask", *_BANDS},
}


def _bands(value: int) -> list[int]:
    return [(value >> shift) & 0xFFFF for shift in (48, 32, 16, 0)]


class PhashTable:
    def __init__(self, path: Path) -> None:
        try:
            self._con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, check_same_thread=False)
            for table, columns in _SCHEMA.items():
                found = {row[1] for row in self._con.execute(f"pragma table_xinfo({table})")}
                if not columns <= found:
                    raise SolverFilesError(f"captcha.sqlite table {table} does not match the expected schema")
        except sqlite3.Error as error:
            raise SolverFilesError(f"captcha.sqlite cannot be read: {error}") from error

    def _nearest(self, table: str, column: str, label: str, value: int) -> int | None:
        b = _bands(value)
        clauses = " or ".join(f"({_BANDS[i]} = ? and {_BANDS[j]} = ?)" for i, j in _PAIRS)
        params: list[object] = [label]
        for i, j in _PAIRS:
            params += [b[i], b[j]]
        rows = self._con.execute(
            f"select phash, {column} from {table} where label = ? and ({clauses})", params
        ).fetchall()
        best: tuple[int, int] | None = None
        for stored, payload in rows:
            distance = hamming(value, (stored if isinstance(stored, int) else int(stored, 0)))
            if distance <= MAX_DISTANCE and (best is None or distance < best[0]):
                best = (distance, payload)
        return None if best is None else best[1]

    def lookup_tile(self, label: str, value: int) -> bool | None:
        selected = self._nearest("phash33", "selected", label, value)
        return None if selected is None else bool(selected)

    def lookup_grid(self, label: str, value: int) -> list[bool] | None:
        mask = self._nearest("phash44", "mask", label, value)
        if mask is None:
            return None
        return [bool(mask >> (15 - i) & 1) for i in range(16)]
