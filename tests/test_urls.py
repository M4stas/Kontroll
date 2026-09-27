import pytest

from auto24_service.urls import InvalidListingURL, canonical_listing_url


def test_canonicalizes_known_host_and_discards_query():
    assert canonical_listing_url(
        "https://eng.auto24.ee/soidukid/4344096?foo=1"
    ) == "https://www.auto24.ee/soidukid/4344096"


@pytest.mark.parametrize(
    "url",
    [
        "http://www.auto24.ee/soidukid/1",
        "https://evil.test/soidukid/1",
        "https://www.auto24.ee/soidukid/1/../../admin",
        "https://user@www.auto24.ee/soidukid/1",
        "https://www.auto24.ee:443/soidukid/1",
        "https://www.auto24.ee/soidukid/1#details",
        "https://www.auto24.ee/soidukid/not-a-number",
    ],
)
def test_rejects_unsafe_listing_urls(url):
    with pytest.raises(InvalidListingURL):
        canonical_listing_url(url)


def test_canonicalizes_all_supported_language_hosts():
    for host in ("auto24.ee", "www.auto24.ee", "rus.auto24.ee"):
        assert canonical_listing_url(
            f"https://{host}/soidukid/17/"
        ) == "https://www.auto24.ee/soidukid/17"


def test_rejects_malformed_authority():
    with pytest.raises(InvalidListingURL):
        canonical_listing_url("https://www.auto24.ee:invalid/soidukid/1")
