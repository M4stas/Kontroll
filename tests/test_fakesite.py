from urllib.parse import urlsplit

import pytest

from fakesite import LISTING_URL, Scenario, install_fake_site

camoufox = pytest.importorskip("camoufox.sync_api")

EXPECTED_PATHS = {
    ("www.auto24.ee", "/soidukid/900001"),
    ("www.auto24.ee", "/services/data_json.php"),
    ("www.auto24.ee", "/favicon.ico"),
    ("www.google.com", "/recaptcha/api.js"),
    ("www.google.com", "/recaptcha/api2/anchor"),
    ("www.google.com", "/recaptcha/api2/bframe"),
    ("www.google.com", "/recaptcha/api2/reload"),
    ("www.google.com", "/recaptcha/api2/userverify"),
    ("www.google.com", "/recaptcha/api2/payload"),
    ("www.google.com", "/favicon.ico"),
}


@pytest.fixture
def context():
    with camoufox.Camoufox(headless=True) as browser:
        ctx = browser.new_context(service_workers="block")
        yield ctx
        ctx.close()


def assert_only_fake_urls(log):
    unexpected = [
        u
        for u in log.requests
        if (urlsplit(u).hostname, urlsplit(u).path) not in EXPECTED_PATHS and urlsplit(u).hostname != "img-bcg.eu"
    ]
    assert unexpected == []
    assert log.fallbacks == []


def test_manual_click_through_reveals_both_values(context):
    log = install_fake_site(context, Scenario(captcha="checkbox_only"))
    page = context.new_page()
    page.goto(LISTING_URL)
    assert page.locator(".field-reg_nr .preview").inner_text() == "123..."

    page.click(".field-reg_nr .service-trigger")
    anchor = page.frame_locator('iframe[src*="/recaptcha/api2/anchor"]')
    anchor.locator("#recaptcha-anchor").click()
    page.wait_for_function("document.querySelector('.field-reg_nr .value').textContent === '123ABC'")
    assert page.locator(".field-reg_nr-gc2").count() == 0
    assert page.locator(".field-reg_nr .service-trigger").count() == 0

    page.click(".field-tehasetahis .service-trigger")
    page.wait_for_function(
        "document.querySelector('.field-tehasetahis .value .-response').textContent === 'WVWZZZ1KZAW000001'"
    )
    assert page.locator('iframe[src*="/recaptcha/api2/anchor"]').count() == 0
    assert log.posted_tokens == 1
    assert sum("/recaptcha/api2/anchor" in u for u in log.requests) == 1
    assert_only_fake_urls(log)


def test_challenge_frame_exposes_reload_label_and_images(context):
    log = install_fake_site(context, Scenario(captcha="challenge", incorrect_rounds=1))
    page = context.new_page()
    page.goto(LISTING_URL)
    page.click(".field-reg_nr .service-trigger")

    with page.expect_response("**/recaptcha/api2/reload*") as reload_info:
        page.frame_locator('iframe[src*="/recaptcha/api2/anchor"]').locator("#recaptcha-anchor").click()
    body = reload_info.value.text()
    assert body.startswith(")]}'\n")
    assert '["pmeta", ["/m/0k4j", null, 3, 3, 3, null, "Car"]]' in body
    assert '"imageselect"' in body

    bframe_el = page.locator('iframe[src*="/recaptcha/api2/bframe"]')
    assert bframe_el.locator("xpath=..").evaluate("e => getComputedStyle(e).position") == "absolute"
    bframe = page.frame_locator('iframe[src*="/recaptcha/api2/bframe"]')
    assert bframe.locator(".rc-imageselect-instructions").inner_text() == "Select all images with cars"
    tiles = bframe.locator("table td img.rc-image-tile-33")
    assert tiles.count() == 9
    assert tiles.first.evaluate("img => img.complete && img.naturalWidth") == 300

    bframe.locator("td").nth(0).click()
    bframe.locator("td").nth(4).click()
    bframe.locator("#recaptcha-verify-button").click()
    bframe.locator(".rc-imageselect-incorrect-response").wait_for(state="visible")

    bframe.locator("td").nth(2).click()
    bframe.locator("#recaptcha-verify-button").click()
    page.wait_for_function("document.querySelector('.field-reg_nr .value').textContent === '123ABC'")
    assert log.verifies == 2
    assert log.clicked_tiles == [[0, 4], [2]]
    assert log.reloads == 2
    assert page.locator(".field-reg_nr-gc2").count() == 0
    assert_only_fake_urls(log)


@pytest.mark.parametrize(
    ("grid", "tile_class", "count", "width"),
    [("4x4", "rc-image-tile-44", 16, 450), ("3x3_dynamic", "rc-image-tile-33", 9, 300)],
)
def test_grid_variants(context, grid, tile_class, count, width):
    log = install_fake_site(context, Scenario(grid=grid))
    page = context.new_page()
    page.goto(LISTING_URL)
    page.click(".field-reg_nr .service-trigger")
    page.frame_locator('iframe[src*="/recaptcha/api2/anchor"]').locator("#recaptcha-anchor").click()
    bframe = page.frame_locator('iframe[src*="/recaptcha/api2/bframe"]')
    tiles = bframe.locator(f"table td img.{tile_class}")
    tiles.first.wait_for()
    assert tiles.count() == count
    assert tiles.first.evaluate("img => img.complete && img.naturalWidth") == width
    if grid == "3x3_dynamic":
        bframe.locator("td").nth(3).click()
        refill = bframe.locator("td").nth(3).locator("img.rc-image-tile-11")
        refill.wait_for()
        page.wait_for_timeout(200)
        assert refill.evaluate("img => img.naturalWidth") == 100
        assert any("payload?p=0" in u and "id=3" in u for u in log.requests)
    assert_only_fake_urls(log)


def test_try_again_later_and_refusal(context):
    install_fake_site(context, Scenario(try_again_later=True))
    page = context.new_page()
    page.goto(LISTING_URL)
    page.click(".field-reg_nr .service-trigger")
    page.frame_locator('iframe[src*="/recaptcha/api2/anchor"]').locator("#recaptcha-anchor").click()
    header = page.frame_locator('iframe[src*="/recaptcha/api2/bframe"]').locator(".rc-doscaptcha-header")
    header.wait_for()


def test_row_states(context):
    install_fake_site(context, Scenario(reg="full", vin="missing"))
    page = context.new_page()
    page.goto(LISTING_URL)
    assert page.locator(".field-reg_nr .value").inner_text() == "123ABC"
    assert page.locator(".field-tehasetahis").count() == 0


def test_refused_reveal_marks_error(context):
    install_fake_site(context, Scenario(refuse_reveal=True))
    page = context.new_page()
    page.goto(LISTING_URL)
    page.click(".field-reg_nr .service-trigger")
    page.wait_for_selector("body[data-reveal-error]", state="attached")
    assert page.locator(".field-reg_nr .service-trigger").count() == 1
