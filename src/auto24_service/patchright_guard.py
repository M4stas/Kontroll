"""Pinned Patchright redirect-route compatibility patch, Chromium image only.

Patchright 1.63.0 bypasses user routes for redirected requests. Removing that
single bypass lets its native Fetch interception guard every hop before contact.
Upgrade requires reviewing the driver again and replacing both complete hashes.
"""
import hashlib
import json
from pathlib import Path

VERSION = '1.63.0'
ORIGINAL_SHA256 = '34898aeefffcbe4f5b3c02d24cc510362fe401055ee26d40a95db91af5152c8d'
PATCHED_SHA256 = '67cb01ea0046388e0a8978b5f69db2ef0274305da3a0f029a82f50bcf9eeaa83'
ORIGINAL_BRANCH = b'if (redirectedFrom || !this._userRequestInterceptionEnabled && this._protocolRequestInterceptionEnabled) {'
PATCHED_BRANCH = b'if (!this._userRequestInterceptionEnabled && this._protocolRequestInterceptionEnabled) {'


def _bundle(path: Path | None) -> Path:
    if path is None:
        import patchright
        path = Path(patchright.__file__).parent / 'driver/package/lib/coreBundle.js'
    path = Path(path)
    if json.loads((path.parent.parent / 'package.json').read_text()).get('version') != VERSION:
        raise ValueError('Unsupported Patchright version')
    return path


def verify_driver(path: Path | None = None) -> None:
    """Refuse unpatched or changed installed drivers; never mutate at runtime."""
    if hashlib.sha256(_bundle(path).read_bytes()).hexdigest() != PATCHED_SHA256:
        raise ValueError('Patchright redirect guard patch missing or changed')


def patch_driver(path: Path | None = None) -> None:
    """Patch only the exact reviewed driver, after checking input and output."""
    path = _bundle(path)
    original = path.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if digest == PATCHED_SHA256:
        return
    if digest != ORIGINAL_SHA256 or original.count(ORIGINAL_BRANCH) != 1:
        raise ValueError('Unexpected Patchright redirect guard source')
    patched = original.replace(ORIGINAL_BRANCH, PATCHED_BRANCH)
    if hashlib.sha256(patched).hexdigest() != PATCHED_SHA256:
        raise ValueError('Unexpected Patchright redirect guard output')
    path.write_bytes(patched)
    verify_driver(path)
