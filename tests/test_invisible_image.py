from pathlib import Path


def test_pinned_and_hashed_requirements():
    for name in ("requirements.txt", "test-requirements.txt"):
        lines = Path("vendor/invisible", name).read_text().splitlines()
        assert all("==" in line and "--hash=sha256:" in line for line in lines if line and not line.startswith("#"))
    requirements = Path("vendor/invisible/requirements.txt").read_text()
    assert "invisible_playwright==0.43.0" in requirements
    assert "invisible_core==53.48.0" in requirements


def test_image_builds_and_fetches_as_worker():
    dockerfile = Path("Dockerfile.invisible").read_text()
    assert "--require-hashes" in dockerfile
    assert "invisible-playwright fetch" in dockerfile
    assert "USER worker" in dockerfile
    assert dockerfile.index("USER worker") < dockerfile.index("invisible-playwright fetch")
    assert "AS runtime" in dockerfile and "AS test" in dockerfile
    runtime, test = dockerfile.split('FROM runtime AS test')
    for stage in (runtime, test):
        users = [line.split()[1] for line in stage.splitlines() if line.startswith('USER ')]
        assert users[-1] == 'worker'
