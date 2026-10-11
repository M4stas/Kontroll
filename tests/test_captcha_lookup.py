import os
import sqlite3
from pathlib import Path

import pytest

from auto24_service.captcha.assets import SolverFilesError
from auto24_service.captcha.lookup import PhashTable

SOLVER_DIR = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))


def bands(v):
    return [(v >> s) & 0xFFFF for s in (48, 32, 16, 0)]


def build(path, tiles=(), grids=()):
    con = sqlite3.connect(path)
    con.execute("create table phash33(label text, phash text, selected integer, band0 integer, band1 integer, band2 integer, band3 integer)")
    con.execute("create table phash44(label text, phash text, mask integer, band0 integer, band1 integer, band2 integer, band3 integer)")
    for label, v, sel in tiles:
        con.execute("insert into phash33 values (?,?,?,?,?,?,?)", (label, str(v), sel, *bands(v)))
    for label, v, mask in grids:
        con.execute("insert into phash44 values (?,?,?,?,?,?,?)", (label, str(v), mask, *bands(v)))
    con.commit()
    con.close()


BASE = 0x1234_5678_9ABC_DEF0 >> 1


def test_tile_hit_within_distance_9(tmp_path):
    build(tmp_path / "t.sqlite", tiles=[("cars", BASE, 1)])
    t = PhashTable(tmp_path / "t.sqlite")
    assert t.lookup_tile("cars", BASE ^ 0b111111111) is True
    assert t.lookup_tile("buses", BASE) is None


def test_tile_miss_at_distance_10(tmp_path):
    build(tmp_path / "t.sqlite", tiles=[("cars", BASE, 1)])
    t = PhashTable(tmp_path / "t.sqlite")
    # flip 10 bits all in band3 and band2 so bands 0 and 1 still match (lookup candidate exists)
    assert t.lookup_tile("cars", BASE ^ 0b1111111111) is None


def test_grid_mask_maps_most_significant_bit_to_tile_0(tmp_path):
    build(tmp_path / "t.sqlite", grids=[("cars", BASE, 0x8001)])
    got = PhashTable(tmp_path / "t.sqlite").lookup_grid("cars", BASE)
    assert len(got) == 16
    assert [i for i, b in enumerate(got) if b] == [0, 15]


def test_nearest_candidate_wins_when_several_match(tmp_path):
    build(tmp_path / "t.sqlite", tiles=[("cars", BASE ^ 0b11111, 0), ("cars", BASE ^ 0b1, 1)])
    assert PhashTable(tmp_path / "t.sqlite").lookup_tile("cars", BASE) is True


def test_schema_mismatch_raises_solver_files_error(tmp_path):
    con = sqlite3.connect(tmp_path / "bad.sqlite")
    con.execute("create table phash33(label text)")
    con.commit()
    con.close()
    with pytest.raises(SolverFilesError):
        PhashTable(tmp_path / "bad.sqlite")


@pytest.mark.skipif(not (SOLVER_DIR / "captcha.sqlite").exists(), reason="solver files not installed")
def test_real_table_has_expected_schema():
    t = PhashTable(SOLVER_DIR / "captcha.sqlite")
    assert t.lookup_tile("cars", 0) in (True, False, None)


@pytest.mark.skipif(not (SOLVER_DIR / "captcha.sqlite").exists(), reason="solver files not installed")
def test_real_table_finds_a_stored_hash():
    con = sqlite3.connect(f"file:{SOLVER_DIR / 'captcha.sqlite'}?mode=ro&immutable=1", uri=True)
    label, value, selected = con.execute("select label, phash, selected from phash33 limit 1").fetchone()
    assert PhashTable(SOLVER_DIR / "captcha.sqlite").lookup_tile(label, value) is bool(selected)
    label, value, mask = con.execute("select label, phash, mask from phash44 limit 1").fetchone()
    grid = PhashTable(SOLVER_DIR / "captcha.sqlite").lookup_grid(label, value)
    assert sum(1 << (15 - i) for i, b in enumerate(grid) if b) == mask
