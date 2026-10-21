"""Parsing Google's challenge data (the pmeta entry) without a browser."""

import json

import pytest

pytest.importorskip("playwright.sync_api")

from auto24_service.captcha.recaptcha import _challenge_parts, pmeta_shape  # noqa: E402


def body(pmeta, kind="imageselect"):
    return ["rresp", "tok", None, 120, pmeta, kind]


def test_real_3x3_layout():
    c = _challenge_parts(body(["pmeta", ["/m/0k4j", None, 3, 3, 3, None, "Car"]]))
    assert (c.label_id, c.name, c.size, c.kind) == ("/m/0k4j", "Car", 3, "imageselect")


def test_4x4_in_the_known_layout():
    c = _challenge_parts(body(["pmeta", ["/m/04_sv", None, 4, 4, 4, None, "motorcycle"]]))
    assert (c.label_id, c.size) == ("/m/04_sv", 4)


@pytest.mark.parametrize("pmeta", [
    ["pmeta", None, ["/m/04_sv", None, 4, 4, 4, None, "motorcycle"]],
    ["pmeta", [None, ["/m/04_sv", None, 4, 4, 4, None, "motorcycle"]]],
    ["pmeta", [[["/m/04_sv", None, 4, 4, 4]]]],
])
def test_label_list_found_elsewhere_in_the_entry(pmeta):
    c = _challenge_parts(body(pmeta, "tileselect"))
    assert c.label_id == "/m/04_sv" and c.size == 4


def test_pmeta_without_a_label_list_still_marks_the_challenge():
    c = _challenge_parts(body(["pmeta", None]))
    assert c is not None and (c.label_id, c.name, c.size) == (None, None, 0)
    assert _challenge_parts(["uvresp", None, None, None]) is None


@pytest.mark.parametrize("meta", [
    ["/m/01lynh", None, 1, 2, 3, None, "stairs"],
    ["/m/01lynh", None, 5, 5, 5],
    ["/m/01lynh", None, "3", 3, 3],
    ["/m/01lynh", 4],
])
def test_size_is_only_trusted_in_the_known_layout(meta):
    c = _challenge_parts(body(["pmeta", meta]))
    assert c.label_id == "/m/01lynh" and c.size == 0 and c.name is None


def test_shape_keeps_structure_and_label_ids_only():
    entry = ["pmeta", None, ["/m/04_sv", None, 4, 4, 4, None, "Secret name", 3.5, True, 999]]
    shape = pmeta_shape(entry)
    assert shape == ["str", None, ["/m/04_sv", None, 4, 4, 4, None, "str", "float", "bool", "int"]]
    text = json.dumps(_challenge_parts(body(entry)).shape)
    assert "Secret" not in text and "pmeta" not in text


def test_shape_limits_depth_and_length():
    deep = ["pmeta", [[[[["/m/0k4j"]]]]]]
    assert pmeta_shape(deep) == ["str", [[["list[1]"]]]]
    long = ["pmeta", list(range(20))]
    assert pmeta_shape(long)[1][-1] == "..." and len(pmeta_shape(long)[1]) == 13
