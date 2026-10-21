import io
import random

from PIL import Image, ImageDraw

from auto24_service.captcha.phash import hamming, phash


def photo(seed: int) -> Image.Image:
    rng = random.Random(seed)
    img = Image.new("RGB", (120, 120))
    draw = ImageDraw.Draw(img)
    for _ in range(25):
        x, y = rng.randrange(120), rng.randrange(120)
        draw.ellipse([x, y, x + rng.randrange(10, 60), y + rng.randrange(10, 60)],
                     fill=tuple(rng.randrange(256) for _ in range(3)))
    return img


def jpeg(img: Image.Image, quality: int) -> Image.Image:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return Image.open(io.BytesIO(buf.getvalue()))


def test_flat_image_hashes_to_zero():
    assert phash(Image.new("RGB", (50, 50), (90, 90, 90))) == 0


def test_hash_fits_in_63_bits():
    assert 0 <= phash(photo(1)) < 1 << 63


def test_recompressed_jpeg_stays_within_distance_6():
    img = photo(2)
    for q in (95, 70):
        assert hamming(phash(img), phash(jpeg(img, q))) <= 6


def test_different_images_differ_by_more_than_20():
    assert hamming(phash(photo(3)), phash(photo(4))) > 20
