"""Map a reCAPTCHA challenge to one of the 16 labels the solver knows."""

import re
from typing import Literal

LABELS: tuple[str, ...] = (
    "bicycles", "boats", "bridges", "buses", "cars", "chimney", "crosswalks", "hydrants",
    "motorcycles", "mountains", "palm", "parkingmeter", "stairs", "taxi", "tractors", "trafficlights",
)

Source = Literal["id", "name", "instruction", "none"]

# Label ids from public reCAPTCHA solver write-ups; the benchmark confirms them.
LABEL_IDS: dict[str, str] = {
    "/m/0k4j": "cars", "/m/01bjv": "buses", "/m/0199g": "bicycles", "/m/015qff": "trafficlights",
    "/m/014xcs": "crosswalks", "/m/01pns0": "hydrants", "/m/04_sv": "motorcycles", "/m/019jd": "boats",
    "/m/015kr": "bridges", "/m/01jk_4": "chimney", "/m/09d_r": "mountains", "/m/0cdl1": "palm",
    "/m/015qbp": "parkingmeter", "/m/01lynh": "stairs", "/m/0pg52": "taxi", "/m/013xlm": "tractors",
}

# ALIAS and the extract/normalize logic below are copied from CaptchaRaptor
# extension/captcha/recaptcha.js at commit 7462474d5fdfda5618becc9ac7a421de3ea69495 (MIT).
ALIAS: dict[str, str] = {
    "fire": "hydrants", "firehydrant": "hydrants", "fire_hydrant": "hydrants", "hydrant": "hydrants",
    "bicycle": "bicycles", "bike": "bicycles", "boat": "boats", "bridge": "bridges", "bus": "buses",
    "car": "cars", "chimney": "chimney", "chimneys": "chimney", "crosswalk": "crosswalks",
    "zebra": "crosswalks", "pedestrian": "crosswalks", "motorcycle": "motorcycles",
    "mountain": "mountains", "palm": "palm", "parkingmeter": "parkingmeter", "parking": "parkingmeter",
    "stairs": "stairs", "stair": "stairs", "taxi": "taxi", "taxis": "taxi", "tractor": "tractors",
    "tractors": "tractors", "traffic": "trafficlights", "trafficlight": "trafficlights",
    "trafficlights": "trafficlights",
}

_WITH = re.compile(r"\bwith\s+(?:an?\s+)?([a-z]+)")


def _extract_label(text: str) -> str:
    text = text.lower()
    match = _WITH.search(text)
    if match:
        return match.group(1)
    words = re.findall(r"[a-z_]+", text)
    return words[-1] if words else ""


def _normalize(raw: str) -> str | None:
    if not raw:
        return None
    label = ALIAS.get(raw) or (raw if raw.endswith("s") else raw + "s")
    return label if label in LABELS else None


# Estonian stems matched against word starts, most specific first ("autobuss" before "auto").
# The wording is a best guess; the benchmark will confirm the real Estonian challenge text.
ESTONIAN_STEMS: tuple[tuple[str, str], ...] = (
    ("autobuss", "buses"), ("bussi", "buses"), ("buss", "buses"),
    ("mootorrat", "motorcycles"), ("mopeed", "motorcycles"),
    ("jalgrat", "bicycles"), ("rattur", "bicycles"), ("ratta", "bicycles"), ("ratas", "bicycles"),
    ("valgusfoor", "trafficlights"), ("foor", "trafficlights"), ("liiklusvalgus", "trafficlights"),
    ("ülekäigu", "crosswalks"), ("sebra", "crosswalks"),
    ("tuletõrje", "hydrants"), ("hüdrant", "hydrants"),
    ("parkimis", "parkingmeter"),
    ("takso", "taxi"), ("traktor", "tractors"),
    ("auto", "cars"),
    ("paat", "boats"), ("paadi", "boats"), ("laev", "boats"),
    ("sild", "bridges"), ("korsten", "chimney"),
    ("mägi", "mountains"), ("mäe", "mountains"), ("mäed", "mountains"), ("mäg", "mountains"),
    ("palm", "palm"), ("trepp", "stairs"), ("trepi", "stairs"),
)


def _estonian(text: str) -> str | None:
    words = re.findall(r"[^\W\d_]+", text.casefold())
    for stem, label in ESTONIAN_STEMS:
        if any(word.startswith(stem) for word in words):
            return label
    return None


def resolve_label(
    label_id: str | None, name: str | None, instruction: str | None
) -> tuple[str | None, Source]:
    if label_id in LABEL_IDS:
        return LABEL_IDS[label_id], "id"
    if name:
        label = _normalize(_extract_label(name))
        if label:
            return label, "name"
    if instruction:
        label = _normalize(_extract_label(instruction)) or _estonian(instruction)
        if label:
            return label, "instruction"
    return None, "none"
