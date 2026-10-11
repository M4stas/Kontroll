import pytest

from auto24_service.captcha.labels import LABELS, resolve_label


def test_sixteen_labels():
    assert len(LABELS) == 16 and len(set(LABELS)) == 16


@pytest.mark.parametrize("label_id,expected", [("/m/0k4j", "cars"), ("/m/01bjv", "buses"), ("/m/015qff", "trafficlights")])
def test_label_id_wins(label_id, expected):
    assert resolve_label(label_id, "whatever", "Valige kõik pildid") == (expected, "id")


@pytest.mark.parametrize("text,expected", [
    ("Select all images with cars", "cars"), ("Select all squares with traffic lights", "trafficlights"),
    ("Select all images with a fire hydrant", "hydrants"), ("Select all images with parking meters", "parkingmeter"),
    ("Valige kõik pildid, millel on autod", "cars"), ("Valige kõik ruudud autobussidega", "buses"),
    ("Valige kõik pildid valgusfooridega", "trafficlights"), ("Valige kõik pildid taksodega", "taxi"),
    ("Valige kõik pildid mootorratastega", "motorcycles"), ("Valige kõik pildid ülekäiguradadega", "crosswalks"),
    ("Valige kõik ruudud autodega", "cars")])
def test_instruction_text_in_english_and_estonian(text, expected):
    assert resolve_label(None, None, text) == (expected, "instruction")


def test_name_from_challenge_data_is_used_when_id_is_unknown():
    assert resolve_label("/m/unknown", "Car", None) == ("cars", "name")


def test_unknown_label_is_explicit():
    assert resolve_label("/m/x", "Giraffe", "Select all images with giraffes") == (None, "none")
