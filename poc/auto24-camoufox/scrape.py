"""Throwaway Camoufox feasibility probe for public Auto24 passenger-car pages."""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from camoufox.sync_api import Camoufox


ALLOWED_HOSTS = {"auto24.ee", "www.auto24.ee", "eng.auto24.ee", "rus.auto24.ee"}


def canonical_url(raw: str) -> str:
    parts = urlsplit(raw)
    match = re.fullmatch(r"/soidukid/([0-9]+)/?", parts.path)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS or not match:
        raise ValueError("Expected an HTTPS Auto24 /soidukid/{id} listing URL")
    return f"https://www.auto24.ee/soidukid/{match.group(1)}"


def compact(value: str) -> str:
    return " ".join(value.split())


def parse_html(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.find("h1")
    if heading is None:
        raise ValueError("Listing heading not found")
    title = compact(heading.find(string=True, recursive=False) or heading.get_text(" ", strip=True))

    fields = {}
    for row in soup.select("table.main-data tr"):
        label = row.select_one("td.label")
        value = row.select_one("td.field .value")
        if label and value:
            key = compact(label.get_text(" ", strip=True))
            text = compact(value.get_text(" ", strip=True))
            if key and text and text != "Kontrolli ajalugu":
                fields[key] = text
    if fields.get("Liik") not in {"sõiduauto", "maastur"}:
        raise ValueError("Page is not an active passenger-car listing")

    equipment = {}
    for label in soup.select(".vEquipment h3.heading"):
        group = label.find_next_sibling("ul")
        if group:
            items = [compact(item.get_text(" ", strip=True)) for item in group.select("li.item")]
            equipment[compact(label.get_text(" ", strip=True))] = [item for item in items if item]

    technical_specs = {}
    for label in soup.select(".vTechData h3.heading"):
        group = label.find_next_sibling("table")
        if group is None:
            continue
        rows = {}
        for row in group.select("tr.item"):
            key = row.select_one("td.label")
            value = row.select_one("td.value")
            if key and value:
                rows[compact(key.get_text(" ", strip=True)).rstrip(":")] = compact(value.get_text(" ", strip=True))
        technical_specs[compact(label.get_text(" ", strip=True))] = rows

    other_info = {}
    other = soup.select_one(".other-info")
    if other:
        for child in other.find_all("div", recursive=False):
            classes = child.get("class", [])
            if "-user_other" not in classes:
                key = next((part.lstrip("-") for part in classes if part.startswith("-")), "other")
                other_info[key] = compact(child.get_text(" ", strip=True))

    description_node = soup.select_one(".other-info .-user_other")
    description = None
    if description_node:
        for line_break in description_node.find_all("br"):
            line_break.replace_with("\n")
        for block in description_node.find_all(["p", "div"]):
            block.append("\n")
        description = description_node.get_text("", strip=False).strip()

    photos = []
    for item in soup.select("#lightgallery a.vImages__item[href]"):
        photo_url = item["href"]
        if "img-bcg.eu" in photo_url and photo_url not in photos:
            photos.append(photo_url)

    seller_name = soup.select_one("address.seller h2")
    registration = fields.get("Esmane reg")
    registration_match = re.fullmatch(r"(\d{2})/(\d{4})", registration or "")
    mileage_match = re.search(r"([\d\s]+)\s*km", fields.get("Läbisõidumõõdiku näit", ""))
    price_match = re.search(r"([\d\s]+)\s*EUR", fields.get("Hind", ""))
    updated = soup.select_one("#bookItem2[data-changed]")

    return {
        "source_url": url,
        "listing_id": url.rsplit("/", 1)[-1],
        "parsed_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "listing_updated_at": updated.get("data-changed") if updated else None,
        "title": title,
        "first_registration": f"{registration_match.group(2)}-{registration_match.group(1)}" if registration_match else None,
        "year": int(registration_match.group(2)) if registration_match else None,
        "mileage_km": int(re.sub(r"\D", "", mileage_match.group(1))) if mileage_match else None,
        "price_eur": int(re.sub(r"\D", "", price_match.group(1))) if price_match else None,
        "fields": fields,
        "equipment": equipment,
        "technical_specs": technical_specs,
        "other_info": other_info,
        "seller_description": description,
        "seller": {"name": compact(seller_name.get_text(" ", strip=True))} if seller_name else None,
        "photo_urls": photos,
    }


def scrape(url: str, save_html: Path | None = None) -> dict:
    with Camoufox(headless=True) as browser:
        page = browser.new_page()
        response = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(2_000)
        html = page.content()
        if save_html is not None:
            save_html.write_text(html, encoding="utf-8")
        status = response.status if response is not None else None
        if status in {404, 410}:
            raise ValueError(f"Listing unavailable (HTTP {status})")
        if status == 403 or "Just a moment..." in page.title() or "cf-challenge" in html.lower():
            raise ValueError(f"Access blocked by challenge (HTTP {status})")
        if "Kuulutus ei ole aktiivne!" in html:
            raise ValueError("Listing is inactive")
        if page.url != url:
            raise ValueError(f"Unexpected final URL: {page.url}")
        result = parse_html(html, url)
        result["http_status"] = status
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Public Auto24 passenger-car listing URL")
    parser.add_argument("--save-html", type=Path, help="Optional diagnostic HTML output path")
    args = parser.parse_args()
    try:
        url = canonical_url(args.url)
        result = scrape(url, args.save_html)
    except Exception as exc:
        print(json.dumps({"error": str(exc), "type": type(exc).__name__}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
