import io
import random

from PIL import Image

from auto24_service.captcha.phash import phash
from auto24_service.captcha.solver import Solver


def png(color, size=(30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def grid_png(n):
    """n x n image whose cells are distinct seeded noise (flat cells would share one hash)."""
    rng = random.Random(7)
    img = Image.new("RGB", (n * 32, n * 32))
    img.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(n * n * 1024)])
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def cell_hashes(data, n):
    img = Image.open(io.BytesIO(data)).convert("RGB")
    w = img.width // n
    return [phash(img.crop(((i % n) * w, (i // n) * w, (i % n) * w + w, (i // n) * w + w))) for i in range(n * n)]


class FakeTable:
    def __init__(self, tiles=None, grids=None):
        self.tiles = tiles or {}  # phash -> bool
        self.grids = grids or {}

    def lookup_tile(self, label, value):
        return self.tiles.get(value)

    def lookup_grid(self, label, value):
        return self.grids.get(value)


class FakeModels:
    def __init__(self, tile=None, grid=None, thresholds=None, tile_threshold=0.5):
        self.tile = tile
        self.grid = grid
        self.thresholds = thresholds or [0.5] * 16
        self._tt = tile_threshold
        self.tile_calls = []

    def tile_scores(self, label, tiles):
        self.tile_calls.append(len(tiles))
        return None if self.tile is None else self.tile(len(tiles))

    def tile_threshold(self, label):
        return self._tt

    def grid_scores(self, label, image):
        return self.grid

    def grid_thresholds(self, label):
        return self.thresholds


def solver(table=None, models=None, seed=0):
    return Solver(table or FakeTable(), models or FakeModels(), random.Random(seed))


def test_3x3_uses_lookup_first_and_model_only_for_misses():
    data = grid_png(3)
    h = cell_hashes(data, 3)
    table = FakeTable(tiles={h[i]: i in (0, 2, 4) for i in range(5)})
    models = FakeModels(tile=lambda n: [0.9, 0.1, 0.1, 0.1][:n])
    d = solver(table, models).solve_grid("bicycles", "3x3", data)
    assert models.tile_calls == [4]
    assert [t.method for t in d.tiles] == ["lookup"] * 5 + ["model"] * 4
    assert d.lookup_hits == 5
    assert [t.selected for t in d.tiles] == [True, False, True, False, True, True, False, False, False]
    assert d.tiles[5].score == 0.9 and d.tiles[0].score is None


def test_3x3_raises_two_selected_to_three_and_marks_adjusted():
    data = grid_png(3)
    h = cell_hashes(data, 3)
    table = FakeTable(tiles={h[i]: i < 2 for i in range(9)})
    d = solver(table).solve_grid("bicycles", "3x3", data)
    assert sum(t.selected for t in d.tiles) == 3
    assert sum(t.adjusted for t in d.tiles) == 1
    assert [t.adjusted for t in d.tiles if t.adjusted] and next(t for t in d.tiles if t.adjusted).selected


def test_3x3_lowers_six_selected_to_four():
    data = grid_png(3)
    h = cell_hashes(data, 3)
    table = FakeTable(tiles={h[i]: i < 6 for i in range(9)})
    d = solver(table).solve_grid("bicycles", "3x3", data)
    assert sum(t.selected for t in d.tiles) == 4
    assert sum(t.adjusted for t in d.tiles) == 2
    assert all(not t.selected for t in d.tiles if t.adjusted)


def test_refilled_tiles_are_not_forced_to_three():
    models = FakeModels(tile=lambda n: [0.9, 0.1][:n])
    d = solver(models=models).solve_tiles("bicycles", [png("red"), png("blue")])
    assert [t.selected for t in d.tiles] == [True, False]
    assert not any(t.adjusted for t in d.tiles)


def test_4x4_lookup_hit_returns_mask():
    data = grid_png(4)
    mask = [i % 2 == 0 for i in range(16)]
    full = Image.open(io.BytesIO(data)).convert("RGB")
    d = solver(FakeTable(grids={phash(full): mask})).solve_grid("bicycles", "4x4", data)
    assert [t.selected for t in d.tiles] == mask
    assert all(t.method == "lookup" for t in d.tiles)
    assert d.lookup_hits == 16


def test_4x4_single_model_pick_adds_next_best_tile():
    scores = [0.1] * 16
    scores[3] = 0.9
    scores[7] = 0.4
    d = solver(models=FakeModels(grid=scores)).solve_grid("bicycles", "4x4", grid_png(4))
    assert [i for i, t in enumerate(d.tiles) if t.selected] == [3, 7]
    assert d.tiles[7].adjusted and not d.tiles[3].adjusted
    assert all(t.method == "model" for t in d.tiles)


def test_4x4_never_applies_random_flips():
    scores = [0.9 if i in (1, 5, 9) else 0.1 for i in range(16)]
    results = {
        tuple(t.selected for t in solver(models=FakeModels(grid=scores), seed=s).solve_grid("bicycles", "4x4", grid_png(4)).tiles)
        for s in range(100)
    }
    assert len(results) == 1


def test_label_missing_from_model_returns_none_only_when_lookup_misses():
    data = grid_png(3)
    h = cell_hashes(data, 3)
    assert solver(models=FakeModels(tile=None)).solve_grid("cars", "3x3", data) is None
    assert solver(models=FakeModels(grid=None)).solve_grid("cars", "4x4", grid_png(4)) is None
    full = FakeTable(tiles={x: i < 3 for i, x in enumerate(h)})
    assert solver(full, FakeModels(tile=None)).solve_grid("cars", "3x3", data) is not None
