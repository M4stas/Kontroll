"""Per-challenge tile decisions: hash lookup first, ONNX model for the rest."""

import io
import random
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal, Protocol

from PIL import Image

from ..contracts import TileRecord
from .lookup import PhashTable
from .models import SolverModels
from .phash import phash


@dataclass(frozen=True)
class Decision:
    tiles: list[TileRecord]

    @property
    def lookup_hits(self) -> int:
        return sum(1 for tile in self.tiles if tile.method == "lookup")


class SolverLike(Protocol):
    def solve_grid(self, label: str, kind: Literal["3x3", "4x4"], image: bytes) -> Decision | None: ...
    def solve_tiles(self, label: str, tiles: list[bytes]) -> Decision | None: ...


def _decode(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def _split(image: Image.Image, n: int) -> list[Image.Image]:
    w, h = image.width / n, image.height / n
    return [
        image.crop((round(c * w), round(r * h), round((c + 1) * w), round((r + 1) * h)))
        for r in range(n)
        for c in range(n)
    ]


class Solver:
    def __init__(self, table: PhashTable, models: SolverModels, rng: random.Random) -> None:
        self._table = table
        self._models = models
        self._rng = rng

    def solve_grid(self, label: str, kind: Literal["3x3", "4x4"], image: bytes) -> Decision | None:
        decoded = _decode(image)
        if kind == "4x4":
            return self._solve_4x4(label, decoded)
        decision = self._decide_tiles(label, _split(decoded, 3))
        if decision is None:
            return None
        return Decision(self._three_to_four(decision.tiles))

    def solve_tiles(self, label: str, tiles: list[bytes]) -> Decision | None:
        return self._decide_tiles(label, [_decode(t) for t in tiles])

    def _decide_tiles(self, label: str, images: list[Image.Image]) -> Decision | None:
        looked = [self._table.lookup_tile(label, phash(img)) for img in images]
        misses = [i for i, v in enumerate(looked) if v is None]
        scores: list[float] = []
        if misses:
            got = self._models.tile_scores(label, [images[i] for i in misses])
            if got is None:
                return None
            scores = got
        threshold = self._models.tile_threshold(label) if misses else 0.0
        records: list[TileRecord] = []
        by_miss = dict(zip(misses, scores))
        for i, value in enumerate(looked):
            if value is not None:
                records.append(TileRecord(method="lookup", selected=value))
            else:
                records.append(TileRecord(method="model", score=by_miss[i], selected=by_miss[i] >= threshold))
        return Decision(records)

    def _three_to_four(self, tiles: list[TileRecord]) -> list[TileRecord]:
        count = sum(t.selected for t in tiles)
        if 3 <= count <= 4:
            return tiles
        out = list(tiles)
        if count < 3:
            pool = [i for i, t in enumerate(out) if not t.selected]
            pool.sort(key=lambda i: (-(out[i].score if out[i].score is not None else -1.0), self._rng.random()))
            for i in pool[: 3 - count]:
                out[i] = out[i].model_copy(update={"selected": True, "adjusted": True})
        else:
            pool = [i for i, t in enumerate(out) if t.selected]
            pool.sort(key=lambda i: ((out[i].score if out[i].score is not None else 2.0), self._rng.random()))
            for i in pool[: count - 4]:
                out[i] = out[i].model_copy(update={"selected": False, "adjusted": True})
        return out

    def _solve_4x4(self, label: str, image: Image.Image) -> Decision | None:
        mask = self._table.lookup_grid(label, phash(image))
        if mask is not None:
            return Decision([TileRecord(method="lookup", selected=m) for m in mask])
        scores = self._models.grid_scores(label, image)
        if scores is None:
            return None
        thresholds = self._models.grid_thresholds(label)
        records = [TileRecord(method="model", score=s, selected=s >= t) for s, t in zip(scores, thresholds)]
        if sum(r.selected for r in records) == 1:
            rest = [i for i, r in enumerate(records) if not r.selected]
            best = max(rest, key=lambda i: scores[i] - thresholds[i])
            records[best] = records[best].model_copy(update={"selected": True, "adjusted": True})
        return Decision(records)


@cache
def load_solver(solver_dir: Path) -> Solver:
    table = PhashTable(solver_dir / "captcha.sqlite")
    return Solver(table, SolverModels(solver_dir), random.Random())
