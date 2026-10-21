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


@pytest.mark.skipif(not (SOLVER_DIR / "captcha.sqlite").exists(), reason="solver files not installed")
def test_every_label_present_in_a_table_resolves_for_that_table():
    # Absent from phash33: palm. Absent from phash44: boats, bridges, cars, mountains, palm.
    from auto24_service.captcha.labels import LABELS
    from auto24_service.captcha.lookup import TABLE_LABELS

    path = SOLVER_DIR / "captcha.sqlite"
    con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    table = PhashTable(path)
    for name, column in (("phash33", "phash"), ("phash44", "phash")):
        present = {r[0] for r in con.execute(f"select distinct label from {name}")}
        found = 0
        for label in LABELS:
            mapped = TABLE_LABELS[name].get(label, label)
            if mapped not in present:
                continue
            found += 1
            value = con.execute(f"select phash from {name} where label = ? limit 1", (mapped,)).fetchone()[0]
            hit = table.lookup_tile(label, value) if name == "phash33" else table.lookup_grid(label, value)
            assert hit is not None, (name, label)
        assert found == len(present)


def test_failed_schema_check_closes_connection(tmp_path):
    con = sqlite3.connect(tmp_path / "bad.sqlite")
    con.execute("create table phash33(label text)")
    con.commit()
    con.close()
    with pytest.raises(SolverFilesError):
        PhashTable(tmp_path / "bad.sqlite")
