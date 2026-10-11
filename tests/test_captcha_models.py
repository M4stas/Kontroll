import os
from pathlib import Path

import pytest
from PIL import Image

from auto24_service.captcha.models import SolverModels
from auto24_service.captcha.solver import load_solver

SOLVER_DIR = Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver"))
pytestmark = pytest.mark.skipif(not SOLVER_DIR.exists(), reason="solver files not installed")


@pytest.fixture(scope="module")
def models():
    return SolverModels(SOLVER_DIR)


def test_type_model_scores_nine_tiles_between_0_and_1(models):
    scores = models.tile_scores("bicycles", [Image.new("RGB", (80, 80), (i * 20, 90, 40)) for i in range(9)])
    assert len(scores) == 9 and all(0.0 <= s <= 1.0 for s in scores)


def test_type_model_returns_none_for_unknown_label(models):
    assert models.tile_scores("unicorns", [Image.new("RGB", (80, 80))]) is None


def test_grid_model_returns_16_scores_for_a_known_label(models):
    scores = models.grid_scores("hydrants", Image.new("RGB", (300, 300), (30, 120, 60)))
    assert len(scores) == 16 and all(0.0 <= s <= 1.0 for s in scores)
    assert len(models.grid_thresholds("hydrants")) == 16


def test_grid_model_returns_none_for_cars(models):
    assert models.grid_scores("cars", Image.new("RGB", (300, 300))) is None


def test_load_solver_returns_the_same_instance():
    assert load_solver(SOLVER_DIR) is load_solver(SOLVER_DIR)
