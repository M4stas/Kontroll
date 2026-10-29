from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from pip._internal.network.session import PipSession
from pip._internal.req.req_file import parse_requirements


@pytest.mark.parametrize("name", ["requirements.txt", "test-requirements.txt"])
def test_pinned_and_hashed_requirements(name):
    with PipSession() as session:
        entries = list(parse_requirements(str(Path("vendor/invisible", name)), session=session))
    assert entries
    requirements = {}
    for entry in entries:
        requirement = Requirement(entry.requirement)
        pins = list(requirement.specifier)
        assert len(pins) == 1
        assert pins[0].operator == "==" and "*" not in pins[0].version
        assert requirement.url is None
        hashes = entry.options.get("hashes", {}).get("sha256", [])
        assert hashes
        for digest in hashes:
            assert len(bytes.fromhex(digest)) == 32
        requirements[canonicalize_name(requirement.name)] = pins[0].version
    if name == "requirements.txt":
        assert requirements["invisible-playwright"] == "0.43.0"
        assert requirements["invisible-core"] == "53.48.0"
