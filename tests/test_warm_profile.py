from datetime import datetime, timezone

import pytest

from auto24_service.contracts import AttemptRecord, RevealDiagnostics
from auto24_service.warm_profile import WarmProfile, is_blocked


def test_reset_after_30_jobs(tmp_path):
    profile = WarmProfile(tmp_path / "warm")
    old = profile.path()
    for jobs in range(1, 30):
        assert profile.record(False) is None
        assert profile.jobs == jobs
        assert profile.path() == old
    assert profile.record(False) == "count"
    assert profile.jobs == 0
    assert profile.path() != old


def test_reset_after_10_hours(tmp_path):
    now = [0.0]
    profile = WarmProfile(tmp_path / "warm", clock=lambda: now[0])
    profile.path()
    now[0] = 35_999
    assert profile.record(False) is None
    now[0] = 36_000
    assert profile.record(False) == "age"
    assert profile.jobs == 0
    profile.path()
    assert profile.record(False) is None


def test_reset_right_after_a_block(tmp_path):
    profile = WarmProfile(tmp_path / "warm")
    old = profile.path()
    assert profile.record(True) == "blocked"
    assert profile.jobs == 0
    assert not old.exists()
    assert profile.path() != old


def test_reset_removes_the_old_folder(tmp_path):
    profile = WarmProfile(tmp_path / "warm", max_jobs=1)
    old = profile.path()
    (old / "nested").mkdir()
    (old / "nested" / "cookie").write_text("stale")
    assert profile.record(False) == "count"
    assert not old.exists()
    new = profile.path()
    assert new.is_dir()
    assert list(new.iterdir()) == []


def test_failed_delete_never_reuses_a_blocked_profile(tmp_path, monkeypatch):
    profile = WarmProfile(tmp_path / "warm")
    old = profile.path()

    def failed_delete(path, *, ignore_errors=False):
        if not ignore_errors:
            raise OSError("profile folder cannot be deleted")

    monkeypatch.setattr("auto24_service.warm_profile.shutil.rmtree", failed_delete)
    assert profile.record(True) == "blocked"
    assert profile.jobs == 0
    assert old.is_dir()
    new = profile.path()
    assert new != old
    assert new.is_dir()
    assert list(new.iterdir()) == []


def test_new_warm_profile_clears_the_root(tmp_path):
    root = tmp_path / "warm"
    leftover = root / "profile-0"
    leftover.mkdir(parents=True)
    (leftover / "stale").write_text("stale")
    profile = WarmProfile(root)
    assert root.is_dir()
    assert list(root.iterdir()) == []
    assert profile.jobs == 0
    assert profile.path() == root / "profile-0"
    assert list(profile.path().iterdir()) == []


def test_age_starts_on_first_use(tmp_path):
    now = [0.0]
    profile = WarmProfile(tmp_path / "warm", max_age_s=10, clock=lambda: now[0])
    now[0] = 100
    profile.path()
    now[0] = 109
    assert profile.record(False) is None
    now[0] = 110
    assert profile.record(False) == "age"
    now[0] = 200
    profile.path()
    assert profile.record(False) is None


@pytest.mark.parametrize("blocked, expected", [(True, "blocked"), (False, "count")])
def test_reset_priority(tmp_path, blocked, expected):
    now = [0.0]
    profile = WarmProfile(tmp_path / "warm", max_jobs=1, max_age_s=10, clock=lambda: now[0])
    profile.path()
    now[0] = 10
    assert profile.record(blocked) == expected


@pytest.mark.parametrize(
    "error_code, reasons, expected",
    [
        ("access_blocked", None, True),
        (None, [None, "try_again_later"], True),
        ("navigation_failed", ["timeout"], False),
        (None, [None], False),
        (None, [], False),
        (None, None, False),
    ],
)
def test_is_blocked(error_code, reasons, expected):
    diagnostics = None if reasons is None else RevealDiagnostics(attempts=[
        AttemptRecord(
            attempt=index + 1,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            duration_ms=0,
            outcome="failed" if reason else "no_captcha_needed",
            reason=reason,
        )
        for index, reason in enumerate(reasons)
    ])
    assert is_blocked(error_code, diagnostics) is expected
