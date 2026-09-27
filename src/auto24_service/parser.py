"""Deterministic extraction of visible data from Auto24 listing HTML."""

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, NavigableString, Tag

from auto24_service.contracts import ListingPrice, ListingResult, SellerInfo
from auto24_service.urls import InvalidListingURL, canonical_listing_url


class ParseError(ValueError):
    """A stable parser failure that can be mapped to a job error code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


_ALIASES = {
    label: field
    for field, labels in {
        "vehicle_type": "liik|type|vehicle type",
        "make": "mark|make|brand",
        "model": "mudel|model",
        "first_registration": "esmane reg|esmaregistreerimine|first registration|date first registered",
        "price": "hind|price",
        "mileage_km": "läbisõidumõõdiku näit|läbisõit|odomeetri näit|mileage",
        "body_type": "keretüüp|kere tüüp|body type",
        "fuel": "kütus|kütuse liik|fuel",
        "power_kw": "mootori võimsus|võimsus|power",
        "gearbox": "käigukast|gearbox",
        "drivetrain": "vedav sild|veoskeem|drivetrain",
        "colour": "värv|värvus|colour|color",
    }.items()
    for label in labels.split("|")
}
_SUPPORTED_VEHICLES = {
    "sõiduauto",
    "maastur",
    "passenger car",
    "car",
    "automobile",
    "suv",
}
_NON_CAR_VEHICLES = {"truck", "kaubik", "van", "bus", "motorcycle", "motorbike", "tractor", "lorry"}
_EXCLUDED_ANCESTORS = (
    "related",
    "similar",
    "recommend",
    "finance",
    "advert",
    "sidebar",
    "other-listing",
)
_JSON_TYPES = {"product", "vehicle", "car", "individualproduct"}


def _compact(value: str) -> str:
    return " ".join(value.split())


def _visible_text(node: Tag) -> str:
    for hidden in node.select("script, style, button, input, .bookmark, [hidden], [aria-hidden='true']"):
        hidden.decompose()
    return _compact(node.get_text(" ", strip=True))


def _page_scope(soup: BeautifulSoup) -> Tag | BeautifulSoup:
    return soup.select_one("main") or soup


def _in_excluded_section(node: Tag, scope: Tag | BeautifulSoup) -> bool:
    for parent in (node, *node.parents):
        if parent is scope:
            break
        name_parts = [str(parent.get("id", "")), *parent.get("class", [])]
        marker = " ".join(name_parts).casefold()
        if any(excluded in marker for excluded in _EXCLUDED_ANCESTORS):
            return True
    return False


def _listing_section(scope: Tag | BeautifulSoup, selector: str) -> Tag | None:
    return next(
        (node for node in scope.select(selector) if not _in_excluded_section(node, scope)),
        None,
    )


def _label_value_rows(scope: Tag | BeautifulSoup) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for table in scope.select("table.main-data"):
        if _in_excluded_section(table, scope):
            continue
        for row in table.select("tr"):
            label = row.select_one("td.label, th.label")
            value = row.select_one("td.field .value, td.value, th.value")
            if label is None or value is None:
                continue
            label_text = _visible_text(label)
            value_text = _visible_text(value)
            if label_text and value_text and value_text != "Kontrolli ajalugu":
                rows.append((label_text, value_text))
    return rows


def _jsonld_objects(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [obj for item in value for obj in _jsonld_objects(item)]
    if not isinstance(value, dict):
        return []
    objects = [value]
    for key in ("@graph", "mainEntity", "itemListElement"):
        if key in value:
            objects.extend(_jsonld_objects(value[key]))
    return objects


def _json_value(value: Any) -> str | None:
    if isinstance(value, list):
        return next((text for item in value if (text := _json_value(item))), None)
    if isinstance(value, dict):
        for key in ("name", "value", "@value", "addressLocality"):
            if key in value and (text := _json_value(value[key])):
                return text
        return None
    if value is None:
        return None
    text = _compact(str(value))
    return text or None


def _metadata_objects(soup: BeautifulSoup) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.string or script.get_text())
        except (json.JSONDecodeError, TypeError):
            continue
        objects.extend(_jsonld_objects(data))
    candidates = []
    for item in objects:
        raw_types = item.get("@type", [])
        types = raw_types if isinstance(raw_types, list) else [raw_types]
        if any(str(kind).casefold() in _JSON_TYPES for kind in types):
            candidates.append(item)
    return candidates or objects


def _metadata_link_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [link for item in value for link in _metadata_link_values(item)]
    if isinstance(value, dict):
        return [
            link
            for key in ("@id", "url")
            for link in _metadata_link_values(value.get(key))
        ]
    return []


def _metadata_listing_objects(
    soup: BeautifulSoup, source_url: str
) -> list[dict[str, Any]]:
    objects = _metadata_objects(soup)
    try:
        target_url = canonical_listing_url(source_url)
    except InvalidListingURL:
        return []

    matching: list[dict[str, Any]] = []
    unlinked: list[dict[str, Any]] = []
    for item in objects:
        urls = _metadata_link_values(item.get("url"))
        identifiers = _metadata_link_values(item.get("@id"))
        has_explicit_link = bool(urls or identifiers)
        if urls:
            candidates = urls
        else:
            candidates = identifiers

        canonical_candidates = set()
        for candidate in candidates:
            try:
                linked_url = urlsplit(urljoin(source_url, candidate))
                canonical_candidates.add(
                    canonical_listing_url(linked_url._replace(fragment="").geturl())
                )
            except ValueError:
                continue

        if target_url in canonical_candidates:
            matching.append(item)
        elif has_explicit_link or canonical_candidates:
            continue
        else:
            unlinked.append(item)

    if matching:
        return matching
    return unlinked if len(objects) == 1 and len(unlinked) == 1 else []


def _first_registration(value: str | None) -> str | None:
    if not value:
        return None
    text = _compact(value)
    match = re.fullmatch(r"(\d{1,2})[./](\d{4})", text)
    if match:
        month, year = int(match.group(1)), match.group(2)
        return f"{year}-{month:02d}" if 1 <= month <= 12 else None
    match = re.fullmatch(r"(\d{4})[-/.](\d{1,2})(?:-\d{1,2})?", text)
    if match:
        year, month = match.group(1), int(match.group(2))
        return f"{year}-{month:02d}" if 1 <= month <= 12 else None
    return text if re.fullmatch(r"\d{4}", text) else None


def _numeric_text(value: str) -> str | None:
    match = re.search(r"[-+]?\d[\d\s\u00a0.,]*", value)
    return re.sub(r"\s", "", match.group(0)) if match else None


def _parse_number(value: str) -> int | float | None:
    number = _numeric_text(value)
    if not number:
        return None
    if "," in number and "." in number:
        decimal = "," if number.rfind(",") > number.rfind(".") else "."
        grouping = "." if decimal == "," else ","
        number = number.replace(grouping, "").replace(decimal, ".")
    elif "," in number or "." in number:
        separator = "," if "," in number else "."
        tail = number.rsplit(separator, 1)[-1]
        if len(tail) == 3 and tail.isdigit():
            number = number.replace(separator, "")
        else:
            number = number.replace(separator, ".")
    try:
        decimal_value = Decimal(number)
    except InvalidOperation:
        return None
    if decimal_value == decimal_value.to_integral_value():
        return int(decimal_value)
    return float(decimal_value)


def _parse_price(value: str | None) -> ListingPrice | None:
    if not value:
        return None
    amount = _parse_number(value)
    if amount is None:
        return None
    upper = value.upper()
    currency = next(
        (
            code
            for marker, code in (("EUR", "EUR"), ("€", "EUR"), ("USD", "USD"), ("$", "USD"), ("SEK", "SEK"), ("GBP", "GBP"), ("£", "GBP"))
            if marker in upper
        ),
        None,
    )
    return ListingPrice(amount=amount, currency=currency)


def _power_kw(value: str | None) -> int | None:
    if not value:
        return None
    amount = _parse_number(value)
    if amount is None:
        return None
    if re.search(r"\b(?:hp|bhp|hj)\b", value, re.IGNORECASE):
        amount = round(float(amount) * 0.73549875)
    return int(amount)


def _metadata_value(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        if key in item and (value := _json_value(item[key])):
            return value
    return None


def _metadata_listing(soup: BeautifulSoup, source_url: str) -> ListingResult:
    listing_id = source_url.rstrip("/").rsplit("/", 1)[-1]
    if not re.fullmatch(r"\d+", listing_id):
        raise ParseError("parse_failed")
    result = ListingResult(source_url=source_url, listing_id=listing_id)
    for item in _metadata_listing_objects(soup, source_url):
        result.title = result.title or _metadata_value(item, "name", "headline")
        result.make = result.make or _json_value(item.get("brand"))
        result.model = result.model or _metadata_value(item, "model")
        registration = _metadata_value(item, "dateVehicleFirstRegistered")
        if registration and (normalized := _first_registration(registration)):
            result.first_registration = result.first_registration or normalized
            result.year = result.year or int(normalized[:4])
            result.year_source = "first_registration"
        if (mileage_text := _json_value(item.get("mileageFromOdometer"))) and result.mileage_km is None:
            result.mileage_km = _parse_int(mileage_text)
        offer = item.get("offers", {})
        offer = next((part for part in offer if isinstance(part, dict)), {}) if isinstance(offer, list) else offer
        price = _json_value(offer.get("price")) if isinstance(offer, dict) else None
        if price and result.price is None:
            result.price = _parse_price(f"{price} {_json_value(offer.get('priceCurrency')) or ''}")
        for attr, key in (("body_type", "bodyType"), ("fuel", "fuelType"), ("gearbox", "vehicleTransmission"), ("drivetrain", "driveWheelConfiguration"), ("colour", "color")):
            setattr(result, attr, getattr(result, attr) or _metadata_value(item, key))
        engine = item.get("vehicleEngine")
        engine = next((part for part in engine if isinstance(part, dict)), {}) if isinstance(engine, list) else engine
        power = _json_value(engine.get("enginePower")) if isinstance(engine, dict) else None
        if power and result.power_kw is None:
            result.power_kw = _power_kw(power)
        seller = item.get("seller")
        if isinstance(seller, dict):
            seller_name = _metadata_value(seller, "name")
            seller_type = _metadata_value(seller, "@type")
            address = seller.get("address")
            location = _metadata_value(address, "addressLocality", "addressRegion") if isinstance(address, dict) else None
            result.seller = SellerInfo(name=seller_name, type=seller_type, location=location)
        if result.seller_description is None:
            result.seller_description = _metadata_value(item, "description")
    return result


def _validate_vehicle_identity(
    soup: BeautifulSoup, rows: list[tuple[str, str]], source_url: str
) -> None:
    row_type = next(
        (value for label, value in rows if _ALIASES.get(label.casefold().rstrip(":").strip()) == "vehicle_type"),
        None,
    )
    if row_type:
        if row_type.casefold() not in _SUPPORTED_VEHICLES:
            raise ParseError("unsupported_vehicle_type")
        return

    for item in _metadata_listing_objects(soup, source_url):
        category = _metadata_value(item, "vehicleType", "vehicleCategory", "category")
        if category:
            category = category.casefold()
            if category in _SUPPORTED_VEHICLES:
                return
            if category in _NON_CAR_VEHICLES:
                raise ParseError("unsupported_vehicle_type")
            raise ParseError("parse_failed")
        types = item.get("@type", [])
        for vehicle_type in types if isinstance(types, list) else [types]:
            kind = str(vehicle_type).rsplit("/", 1)[-1].rsplit("#", 1)[-1].casefold()
            if kind in _SUPPORTED_VEHICLES:
                return
            if kind in _NON_CAR_VEHICLES:
                raise ParseError("unsupported_vehicle_type")
    raise ParseError("parse_failed")


def _parse_int(value: str) -> int | None:
    number = _parse_number(value)
    return int(number) if number is not None else None


def _description(node: Tag | None) -> str | None:
    if node is None:
        return None
    fragment = BeautifulSoup(str(node), "html.parser").find(class_="-user_other")
    if fragment is None:
        return None
    for hidden in fragment.select("script, style, button, input, [hidden], [aria-hidden='true']"):
        hidden.decompose()
    for line_break in fragment.find_all("br"):
        line_break.replace_with(NavigableString("\n"))
    for block in fragment.find_all(["p", "div", "li"]):
        block.insert_before(NavigableString("\n\n"))
    lines = [" ".join(line.split()) for line in fragment.get_text("", strip=False).splitlines()]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)) or None


def _equipment(scope: Tag | BeautifulSoup) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for section in scope.select(".vEquipment"):
        if _in_excluded_section(section, scope):
            continue
        for heading in section.select("h3.heading"):
            group = heading.find_next_sibling("ul")
            name = _visible_text(heading)
            if group is None or not name:
                continue
            values = [_visible_text(item) for item in group.select("li.item")]
            if values:
                groups.setdefault(name, []).extend(value for value in values if value)
    return groups


def _technical_specs(scope: Tag | BeautifulSoup) -> dict[str, str]:
    specs: dict[str, str] = {}
    for section in scope.select(".vTechData"):
        if _in_excluded_section(section, scope):
            continue
        for heading in section.select("h3.heading"):
            table = heading.find_next_sibling("table")
            if table is None:
                continue
            group = _visible_text(heading)
            for row in table.select("tr.item"):
                label = row.select_one("td.label, th.label")
                value = row.select_one("td.value, th.value")
                if label is None or value is None:
                    continue
                key = _visible_text(label).rstrip(":").strip()
                text = _visible_text(value)
                if key and text:
                    specs[f"{group} / {key}" if group else key] = text
    return specs


def _description_node(scope: Tag | BeautifulSoup) -> Tag | None:
    for node in scope.select(".other-info .-user_other"):
        if not _in_excluded_section(node, scope):
            return node
    return None


def _other_info_fields(scope: Tag | BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for section in scope.select(".other-info"):
        if _in_excluded_section(section, scope):
            continue
        for note in section.find_all(["div", "p", "li"], recursive=False):
            classes = note.get("class", [])
            if "-user_other" in classes or _in_excluded_section(note, scope):
                continue
            label = note.select_one(".label, .field_name, dt, strong")
            key = _visible_text(label) if label else next(
                (name[1:].replace("_", " ") for name in classes if name.startswith("-") and name != "-user_other"),
                "",
            )
            value_node = note.select_one(".value")
            if label and value_node:
                value = _visible_text(value_node)
            else:
                copy = BeautifulSoup(str(note), "html.parser").find()
                for part in copy.select(".label, .field_name, dt, strong"):
                    part.decompose()
                value = _visible_text(copy)
            if key and value:
                fields.setdefault(key, value)
    return fields


def _photos(scope: Tag | BeautifulSoup, source_url: str) -> list[str]:
    urls: list[str] = []
    for link in scope.select("#lightgallery a.vImages__item[href]"):
        if _in_excluded_section(link, scope):
            continue
        href = _compact(str(link.get("href", "")))
        parsed = urlsplit(urljoin(source_url, href))
        if parsed.scheme in {"http", "https"}:
            full_url = parsed.geturl()
            if full_url not in urls:
                urls.append(full_url)
    return urls


def _seller_from_dom(scope: Tag | BeautifulSoup) -> SellerInfo | None:
    address = _listing_section(scope, "address.seller")
    if address is None:
        return None
    for control in address.select(".service-trigger, [data-action]"):
        control.decompose()
    name_node = address.select_one("h2")
    name = _visible_text(name_node) if name_node else None
    location_node = address.select_one(".seller-location, .location, .address-locality")
    location = _visible_text(location_node) if location_node else None
    if location is None:
        for candidate in address.select("p, span"):
            if candidate.find_parent("h2") is None:
                location = _visible_text(candidate)
                if location:
                    break
    return SellerInfo(name=name, location=location) if name or location else None


def _apply_rows(result: ListingResult, rows: list[tuple[str, str]]) -> None:
    fields: dict[str, str] = {}
    for label, value in rows:
        key = label.casefold().rstrip(":").strip()
        field = _ALIASES.get(key)
        if field == "vehicle_type":
            if value.casefold() not in _SUPPORTED_VEHICLES:
                raise ParseError("unsupported_vehicle_type")
            fields[label] = value
        elif field == "make":
            result.make = value
        elif field == "model":
            result.model = value
        elif field == "first_registration":
            registration = _first_registration(value)
            if registration:
                result.first_registration = registration
                result.year = int(registration[:4])
                result.year_source = "first_registration"
            else:
                fields[label] = value
        elif field == "price":
            result.price = _parse_price(value)
            if result.price is None:
                fields[label] = value
        elif field == "mileage_km":
            result.mileage_km = _parse_int(value)
            if result.mileage_km is None:
                fields[label] = value
        elif field == "body_type":
            result.body_type = value
        elif field == "fuel":
            result.fuel = value
        elif field == "power_kw":
            result.power_kw = _power_kw(value)
            if result.power_kw is None:
                fields[label] = value
        elif field == "gearbox":
            result.gearbox = value
        elif field == "drivetrain":
            result.drivetrain = value
        elif field == "colour":
            result.colour = value
        else:
            fields[label] = value
    result.other_fields.update(fields)


def _warnings(result: ListingResult) -> list[str]:
    fields = {
        "make": result.make,
        "model": result.model,
        "first_registration": result.first_registration,
        "price": result.price,
        "mileage_km": result.mileage_km,
        "body_type": result.body_type,
        "fuel": result.fuel,
        "power_kw": result.power_kw,
        "gearbox": result.gearbox,
        "drivetrain": result.drivetrain,
        "colour": result.colour,
        "seller_description": result.seller_description,
        "photo_urls": result.photo_urls,
    }
    return [f"missing_{name}" for name, value in fields.items() if not value]


def parse_listing(html: str, canonical_url: str) -> tuple[ListingResult, list[str]]:
    """Parse one already-fetched listing document without requesting resources."""
    soup = BeautifulSoup(html, "html.parser")
    scope = _page_scope(soup)
    heading = next(
        (node for node in soup.select("h1") if not _in_excluded_section(node, scope)),
        None,
    )
    title = _visible_text(heading) if heading else ""
    if not title:
        raise ParseError("parse_failed")

    result = _metadata_listing(soup, canonical_url)
    result.title = title
    rows = _label_value_rows(scope)
    _validate_vehicle_identity(soup, rows, canonical_url)
    _apply_rows(result, rows)
    result.seller_description = _description(_description_node(scope)) or result.seller_description
    rendered_seller = _seller_from_dom(scope)
    if rendered_seller:
        metadata_seller = result.seller
        result.seller = SellerInfo(
            name=rendered_seller.name or (metadata_seller.name if metadata_seller else None),
            type=rendered_seller.type or (metadata_seller.type if metadata_seller else None),
            location=rendered_seller.location or (metadata_seller.location if metadata_seller else None),
        )
    result.other_fields.update(_other_info_fields(scope))
    result.equipment = _equipment(scope)
    result.technical_specs = _technical_specs(scope)
    power_spec = result.technical_specs.get("Mootor / võimsus")
    if result.power_kw is None and power_spec and re.fullmatch(r"\d+\s*kW", power_spec, re.IGNORECASE):
        result.power_kw = _power_kw(power_spec)
    result.photo_urls = _photos(scope, canonical_url) or result.photo_urls
    return result, _warnings(result)
