"""Perceptual hash, ported from CaptchaRaptor extension/captcha/phash-browser.js."""

import numpy as np
from PIL import Image

# The benchmark's hit rate tunes this.
PHASH_RESAMPLE = Image.Resampling.BILINEAR

_N = 32
_K = np.arange(_N)
_DCT = np.sqrt(2.0 / _N) * np.cos(np.pi * (2 * _K[None, :] + 1) * _K[:, None] / (2 * _N))
_DCT[0] /= np.sqrt(2.0)


def phash(image: Image.Image) -> int:
    rgb = np.asarray(image.convert("RGB").resize((_N, _N), PHASH_RESAMPLE), dtype=np.int64)
    gray = (rgb[..., 0] * 299 + rgb[..., 1] * 587 + rgb[..., 2] * 114) // 1000
    coeffs = _DCT @ gray.astype(np.float64) @ _DCT.T
    # Rounding keeps float noise on flat images from setting bits.
    values = np.round(coeffs[:8, :8].ravel()[1:], 6)
    median = sorted(values.tolist())[32]
    result = 0
    for value in values:
        result = (result << 1) | int(value > median)
    return result


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()
