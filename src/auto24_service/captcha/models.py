"""ONNX scoring for 3x3 tiles (type model) and 4x4 grids (grid model)."""

import json
from pathlib import Path

import numpy as np
from PIL import Image

from .assets import SolverFilesError

# Copied from CaptchaRaptor extension/captcha/recaptcha_ai.js at commit
# 7462474d5fdfda5618becc9ac7a421de3ea69495 (MIT).
TYPE_INDEX = {
    "boats": 0, "motorcycles": 1, "palm": 2, "parkingmeter": 3, "stairs": 4, "taxi": 5,
    "tractors": 6, "bicycles": 7, "cars": 8, "hydrants": 9, "crosswalks": 10, "buses": 11,
    "trafficlights": 12, "bridges": 13, "chimney": 14, "mountains": 15,
}
TYPE_THRESHOLDS = {
    "hydrants": 0.139, "bridges": 0.191, "boats": 0.047, "cars": 0.994, "crosswalks": 0.136,
    "taxi": 0.862, "bicycles": 0.065, "trafficlights": 0.137, "motorcycles": 0.154,
    "stairs": 0.075, "mountains": 0.061, "tractors": 0.015, "buses": 0.618, "palm": 0.01,
    "parkingmeter": 0.001, "chimney": 0.006,
}

TILE_SIZE = 100
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def _prepare(images: list[Image.Image], size: int) -> np.ndarray:
    batch = [
        (np.asarray(im.convert("RGB").resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0 - _MEAN) / _STD
        for im in images
    ]
    return np.stack(batch).transpose(0, 3, 1, 2).astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


class SolverModels:
    def __init__(self, solver_dir: Path) -> None:
        import onnxruntime as ort

        try:
            self._type = ort.InferenceSession(str(solver_dir / "type.onnx"), providers=["CPUExecutionProvider"])
            self._grid = ort.InferenceSession(str(solver_dir / "grid.onnx"), providers=["CPUExecutionProvider"])
            meta = json.loads((solver_dir / "grid.meta.json").read_text())
            self._grid_size = int(meta["image_size"])
            self._grid_index = {k: int(v) for k, v in meta["type_to_index"].items()}
            self._grid_thresholds = {k: [float(x) for x in v] for k, v in meta["thresholds_by_type"].items()}
        except (OSError, KeyError, ValueError) as error:
            raise SolverFilesError(f"solver models cannot be loaded: {error}") from error
        except Exception as error:  # onnxruntime raises its own error types
            raise SolverFilesError(f"solver models cannot be loaded: {error}") from error

    def tile_threshold(self, label: str) -> float:
        return TYPE_THRESHOLDS[label]

    def tile_scores(self, label: str, tiles: list[Image.Image]) -> list[float] | None:
        index = TYPE_INDEX.get(label)
        if index is None or not tiles:
            return None if index is None else []
        logits = self._type.run(None, {"input": _prepare(tiles, TILE_SIZE)})[0]
        return [float(v) for v in _sigmoid(logits[:, index])]

    def grid_scores(self, label: str, image: Image.Image) -> list[float] | None:
        index = self._grid_index.get(label)
        if index is None:
            return None
        logits = self._grid.run(None, {"input": _prepare([image], self._grid_size)})[0]
        return [float(v) for v in _sigmoid(logits[0, index])]

    def grid_thresholds(self, label: str) -> list[float]:
        return self._grid_thresholds[label]
