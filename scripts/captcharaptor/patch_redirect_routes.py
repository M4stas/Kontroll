"""Build-image-only Patchright patch; cached download inputs remain untouched."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from auto24_service.patchright_guard import patch_driver

if __name__ == '__main__':
    patch_driver()
