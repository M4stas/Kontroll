import json
from pathlib import Path

import pytest

from auto24_service.parser import ParseError, parse_listing


FIXTURES = Path(__file__).parent / "fixtures"
LISTING_URL = "https://www.auto24.ee/soidukid/4344096"


def _fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_maps_registration_price_and_mileage_from_visible_rows():
    listing, _ = parse_listing(_fixture("auto24-passenger-car.html"), LISTING_URL)

    assert listing.first_registration == "2022-03"
    assert listing.year == 2022
    assert listing.year_source == "first_registration"
    assert listing.price.amount == 41500
    assert listing.price.currency == "EUR"
    assert listing.mileage_km == 46800


def test_maps_car_details_and_keeps_unmapped_row_labels():
    listing, _ = parse_listing(_fixture("auto24-passenger-car.html"), LISTING_URL)

    assert (listing.make, listing.model) == ("Skoda", "Enyaq")
    assert (listing.body_type, listing.fuel, listing.power_kw) == ("universaal", "elekter", 150)
    assert (listing.gearbox, listing.drivetrain, listing.colour) == ("automaat", "nelikvedu", "must")
    assert listing.other_fields == {
        "Liik": "sõiduauto",
        "Ülevaatus kuni": "03.2028",
        "Sõiduki ajalugu": "Hooldusraamat olemas",
        "Hooldusajalugu": "Hooldused tehtud esinduses.",
    }


def test_preserves_seller_prose_and_paragraph_breaks_without_contact_controls():
    listing, _ = parse_listing(_fixture("auto24-passenger-car.html"), LISTING_URL)

    assert listing.seller_description == (
        "Example seller description.\n\nWinter tyres included.\nReady for a test drive."
    )
    assert listing.seller.name == "Example Seller"
    assert listing.seller.type == "Organization"
    assert listing.seller.location == "Example City"
    assert "Näita telefoninumbrit" not in listing.seller_description


def test_keeps_equipment_groups_and_technical_labels():
    listing, _ = parse_listing(_fixture("auto24-passenger-car.html"), LISTING_URL)

    assert listing.equipment == {
        "Turva- ja ohutusvarustus": ["ABS pidurid", "Turvapadjad"],
        "Mugavusvarustus": ["Kliimaseade"],
    }
    assert listing.technical_specs == {
        "Auto tehnilised andmed / istekohti": "5",
        "Auto tehnilised andmed / uste arv": "5",
        "Mõõdud / pikkus": "4 649 mm",
    }


def test_returns_only_listing_gallery_photos_in_dom_order():
    listing, _ = parse_listing(_fixture("auto24-passenger-car.html"), LISTING_URL)

    assert listing.photo_urls == [
        "https://img-bcg.eu/listing/skoda-main.jpg",
        "https://img-bcg.eu/listing/skoda-interior.jpg",
    ]


def test_partial_listing_leaves_optional_values_empty_and_reports_warnings():
    listing, warnings = parse_listing(_fixture("auto24-partial-car.html"), LISTING_URL)

    assert listing.first_registration == "2010"
    assert listing.year == 2010
    assert listing.price is None
    assert listing.mileage_km is None
    assert listing.equipment == {}
    assert listing.technical_specs == {}
    assert listing.photo_urls == []
    assert listing.other_fields == {"Liik": "sõiduauto", "Mootori kood": "ABC123"}
    assert "missing_price" in warnings
    assert "missing_mileage_km" in warnings
    assert "missing_photo_urls" in warnings


def test_rejects_page_marked_as_a_non_car():
    html = '<h1>Delivery van</h1><table class="main-data"><tr><td class="label">Liik</td><td class="value">kaubik</td></tr></table>'

    with pytest.raises(ParseError) as error:
        parse_listing(html, LISTING_URL)

    assert error.value.code == "unsupported_vehicle_type"


def test_missing_listing_heading_is_a_parse_error():
    with pytest.raises(ParseError) as error:
        parse_listing("<main><p>Unrelated page</p></main>", LISTING_URL)

    assert error.value.code == "parse_failed"


def test_heading_alone_does_not_prove_this_is_a_passenger_car():
    with pytest.raises(ParseError) as error:
        parse_listing("<h1>Unrelated page</h1>", LISTING_URL)

    assert error.value.code == "parse_failed"


def test_rejects_non_car_json_ld_vehicle_category():
    metadata = {"@context": "https://schema.org", "@type": "Product", "name": "Truck", "category": "truck"}
    html = f'<h1>Truck</h1><script type="application/ld+json">{json.dumps(metadata)}</script>'

    with pytest.raises(ParseError) as error:
        parse_listing(html, LISTING_URL)

    assert error.value.code == "unsupported_vehicle_type"


def test_uses_json_ld_values_when_rendered_rows_are_absent():
    metadata = {
        "@context": "https://schema.org",
        "@type": "Vehicle",
        "vehicleType": "passenger car",
        "name": "Metadata car",
        "image": "https://images.example.test/metadata-only.jpg",
        "brand": {"name": "Example"},
        "model": "Model X",
        "dateVehicleFirstRegistered": "2021-07",
        "mileageFromOdometer": {"value": "12 300", "unitCode": "KMT"},
        "offers": {"price": "19900", "priceCurrency": "EUR"},
    }
    html = f'<h1>Metadata car</h1><script type="application/ld+json">{json.dumps(metadata)}</script>'

    listing, warnings = parse_listing(html, LISTING_URL)

    assert listing.title == "Metadata car"
    assert listing.make == "Example"
    assert listing.model == "Model X"
    assert listing.first_registration == "2021-07"
    assert listing.mileage_km == 12300
    assert listing.price.amount == 19900
    assert listing.photo_urls == []
    assert "missing_photo_urls" in warnings


def test_json_ld_uses_only_the_object_for_the_requested_listing():
    requested = {
        "@context": "https://schema.org",
        "@type": "Vehicle",
        "@id": LISTING_URL + "#vehicle",
        "vehicleType": "passenger car",
        "model": "Enyaq",
    }
    unrelated = {
        "@context": "https://schema.org",
        "@type": "Vehicle",
        "url": "https://www.auto24.ee/soidukid/9999999",
        "vehicleType": "passenger car",
        "model": "Unrelated car",
        "offers": {"price": "99999", "priceCurrency": "EUR"},
        "seller": {"name": "Unrelated seller"},
    }
    html = (
        '<h1>Requested car</h1>'
        '<table class="main-data"><tr><td class="label">Liik</td>'
        '<td class="value">sõiduauto</td></tr></table>'
        f'<script type="application/ld+json">{json.dumps([unrelated, requested])}</script>'
    )

    listing, _ = parse_listing(html, LISTING_URL)

    assert listing.model == "Enyaq"
    assert listing.price is None
    assert listing.seller is None


def test_json_ld_falls_back_only_when_there_is_one_unlinked_vehicle():
    metadata = [
        {
            "@context": "https://schema.org",
            "@type": "Vehicle",
            "vehicleType": "passenger car",
            "model": "First unlinked car",
        },
        {
            "@context": "https://schema.org",
            "@type": "Vehicle",
            "vehicleType": "passenger car",
            "model": "Second unlinked car",
        },
    ]
    html = (
        '<h1>Requested car</h1>'
        '<table class="main-data"><tr><td class="label">Liik</td>'
        '<td class="value">sõiduauto</td></tr></table>'
        f'<script type="application/ld+json">{json.dumps(metadata)}</script>'
    )

    listing, _ = parse_listing(html, LISTING_URL)

    assert listing.model is None


def test_excludes_nested_bookmark_widget_from_the_listing_title():
    html = '''
    <h1 class="commonSubtitle">Skoda Enyaq 195kW
      <div class="bs-modules bookmark"><span class="bookmarked-cnt">Salvestatud 0 korda</span></div>
    </h1>
    <table class="main-data"><tr><td class="label">Liik</td><td class="value">sõiduauto</td></tr></table>
    '''

    listing, _ = parse_listing(html, LISTING_URL)

    assert listing.title == "Skoda Enyaq 195kW"


def test_does_not_treat_seller_contact_reveal_as_location():
    html = '''
    <h1>Skoda Enyaq 195kW</h1>
    <table class="main-data"><tr><td class="label">Liik</td><td class="value">sõiduauto</td></tr></table>
    <address class="section seller">
      <h2>Toni</h2>
      <ul><li><span class="value service-trigger pnr">Näita telefoninumbrit</span></li>
      <li><a class="service-trigger">Saada e-mail</a></li></ul>
    </address>
    '''

    listing, _ = parse_listing(html, LISTING_URL)

    assert listing.seller.name == "Toni"
    assert listing.seller.location is None


def test_maps_power_from_technical_spec_when_main_row_is_absent():
    html = '''
    <h1>Skoda Enyaq 195kW</h1>
    <table class="main-data"><tr><td class="label">Liik</td><td class="value">sõiduauto</td></tr></table>
    <section class="vTechData"><h3 class="heading">Mootor</h3>
      <table><tr class="item"><td class="label">võimsus</td><td class="value">195 kW</td></tr></table>
    </section>
    '''

    listing, warnings = parse_listing(html, LISTING_URL)

    assert listing.technical_specs == {"Mootor / võimsus": "195 kW"}
    assert listing.power_kw == 195
    assert "missing_power_kw" not in warnings
