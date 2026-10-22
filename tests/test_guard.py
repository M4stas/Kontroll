from dataclasses import FrozenInstanceError

import pytest

from auto24_service import guard


# These expected values specify the old browser guard contract independently.
@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://www.google.com/recaptcha/api2/anchor", True),
        ("https://www.gstatic.com/recaptcha/releases/x/recaptcha__et.js", True),
        ("https://www.google.com/js/bg/x.js", False),
        ("https://www.gstatic.com/other/x.js", False),
        ("https://google.com/recaptcha/x", False),
        ("http://www.google.com/recaptcha/x", False),
        ("https://www.google.com:443/recaptcha/x", False),
        ("https://www.google.com/recaptchax/x", False),
        ("https://www.google.com/recaptcha/..%2fjs/x.js", False),
        ("https://www.google.com/recaptcha/..%2Fjs/x.js", False),
        ("https://www.google.com/recaptcha/%2e%2e/js/x.js", False),
        ("https://www.google.com/recaptcha/../js/x.js", False),
        ("https://www.gstatic.com/recaptcha/..%5cother/x.js", False),
        ("https://www.google.com/recaptcha/api2/x%2Fy", False),
        ("https://www.google.com/recaptcha/%252e%252e/js/x.js", False),
        ("https://www.google.com/recaptcha/api2/%252fjs", False),
        ("https://www.gstatic.com/recaptcha/%25%32%65/x.js", False),
        ("https://www.google.com/recaptcha/api2/a%20b", False),
    ],
)
def test_auto24_allowlist_matches_the_current_guard(url, allowed):
    assert guard.allowed_url(url, main_frame=False) is allowed
    assert guard.allowed_url(url, main_frame=True) is False


@pytest.mark.parametrize("main_frame", [False, True])
@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://www.auto24.ee/soidukid/1234567", True),
        # Host-wide Auto24 path policy is intentionally preserved.
        ("https://www.auto24.ee/../asset%20name\\x", True),
        ("https://assets.auto24.ee/site.css", False),
        ("https://127.0.0.1/admin", False),
        ("https://tracker.example.org/pixel", False),
        ("https://example.org/collect", False),
        ("http://www.auto24.ee/", False),
        ("https://www.auto24.ee:443/", False),
        ("https://user@www.auto24.ee/", False),
        ("https://user:password@www.auto24.ee/", False),
        ("https://www.auto24.ee:/", False),
        ("https://[bad/", False),
    ],
)
def test_auto24_hosts_and_authority(url, allowed, main_frame):
    assert guard.allowed_url(url, main_frame=main_frame) is allowed


EXTENSION_ID = "a" * 32


@pytest.mark.parametrize("extension_id,allowed", [(EXTENSION_ID, True), ("b" * 32, False), (None, False)])
def test_extension_url_allowed_only_for_our_id(extension_id, allowed):
    assert guard.allowed_url(
        f"chrome-extension://{EXTENSION_ID}/models/type.onnx",
        main_frame=False,
        extension_id=extension_id,
    ) is allowed


def test_extension_url_never_allowed_as_main_frame():
    assert guard.allowed_url(
        f"chrome-extension://{EXTENSION_ID}/models/type.onnx",
        main_frame=True,
        extension_id=EXTENSION_ID,
    ) is False


@pytest.mark.parametrize("path", ["models/../type.onnx", "models/%2e/type.onnx", "models/type%20x.onnx", "models\\type.onnx"])
def test_unsafe_paths_still_refused_in_extension_urls(path):
    assert guard.allowed_url(
        f"chrome-extension://{EXTENSION_ID}/{path}",
        main_frame=False,
        extension_id=EXTENSION_ID,
    ) is False


@pytest.mark.parametrize("authority", [f"user@{EXTENSION_ID}", f"{EXTENSION_ID}:443", f"{EXTENSION_ID}:", f"{EXTENSION_ID}.example.org"])
def test_extension_authority_must_match_exactly(authority):
    assert guard.allowed_url(
        f"chrome-extension://{authority}/models/type.onnx",
        main_frame=False,
        extension_id=EXTENSION_ID,
    ) is False


def test_site_allowlist_is_frozen_and_used_for_each_request_kind():
    site = guard.SiteAllowlist(
        main_frame_hosts=frozenset({"main.example.org"}),
        subresource_hosts=frozenset({"assets.example.org"}),
        subresource_prefixes=("https://prefix.example.org/safe/",),
    )
    with pytest.raises(FrozenInstanceError):
        site.main_frame_hosts = frozenset()
    assert guard.AUTO24 == guard.SiteAllowlist(
        frozenset({"www.auto24.ee"}),
        frozenset({"www.auto24.ee"}),
        ("https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"),
    )
    for url, main_frame, expected in [
        ("https://main.example.org/", True, True),
        ("https://main.example.org/", False, False),
        ("https://assets.example.org/", False, True),
        ("https://assets.example.org/", True, False),
        ("https://prefix.example.org/safe/x", False, True),
        ("https://prefix.example.org/safe/../x", False, False),
        ("https://www.auto24.ee/", True, False),
    ]:
        assert guard.allowed_url(url, main_frame=main_frame, site=site) is expected


@pytest.mark.parametrize("url,expected", [
    ("https://www.google.com/js/x?token=fake", "www.google.com/js/"),
    ("https://www.auto24.ee/", "www.auto24.ee/"),
    ("https://[bad/", "invalid/"),
])
def test_blocked_entry_retains_only_host_and_first_path_segment(url, expected):
    assert guard.blocked_entry(url) == expected


MNT_SEARCH = "https://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf"


@pytest.mark.parametrize(
    "url",
    [
        MNT_SEARCH,
        "https://eteenindus.mnt.ee/public/soidukDetailvaadeAvalik.jsf",
        "https://eteenindus.mnt.ee/javax.faces.resource/primefaces.js.jsf?ln=primefaces&v=6.1",
        "https://eteenindus.mnt.ee/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
    ],
)
def test_mnt_allows_its_own_host_in_frames_and_subresources(url):
    assert guard.allowed_url(url, main_frame=False, site=guard.MNT)
    assert guard.allowed_url(url, main_frame=True, site=guard.MNT)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.google.com/recaptcha/api.js?render=site-key",
        "https://www.google.com/recaptcha/api2/anchor",
        "https://www.gstatic.com/recaptcha/releases/x/recaptcha__et.js",
    ],
)
def test_mnt_allows_recaptcha_subresources_only(url):
    assert guard.allowed_url(url, main_frame=False, site=guard.MNT)
    assert not guard.allowed_url(url, main_frame=True, site=guard.MNT)


@pytest.mark.parametrize(
    ("url", "entry"),
    [
        ("https://www.googletagmanager.com/gtm.js?id=GTM-FAKE", "www.googletagmanager.com/gtm.js/"),
        ("https://www.googletagmanager.com/gtag/js?id=G-FAKE", "www.googletagmanager.com/gtag/"),
        ("https://www.google-analytics.com/g/collect?v=2", "www.google-analytics.com/g/"),
        ("https://region1.google-analytics.com/g/collect", "region1.google-analytics.com/g/"),
        ("https://static.cloudflareinsights.com/beacon.min.js", "static.cloudflareinsights.com/beacon.min.js/"),
        ("https://mnt.ee/", "mnt.ee/"),
        ("https://www.mnt.ee/", "www.mnt.ee/"),
        ("http://eteenindus.mnt.ee/public/soidukTaustakontroll.jsf", "eteenindus.mnt.ee/public/"),
        ("https://eteenindus.mnt.ee:443/public/soidukTaustakontroll.jsf", "eteenindus.mnt.ee/public/"),
    ],
)
def test_mnt_blocks_trackers_and_other_hosts_and_lists_them(url, entry):
    for main_frame in (False, True):
        assert not guard.allowed_url(url, main_frame=main_frame, site=guard.MNT)
    assert guard.blocked_entry(url) == entry


def test_mnt_and_auto24_do_not_share_hosts():
    for main_frame in (False, True):
        assert not guard.allowed_url("https://www.auto24.ee/soidukid/1", main_frame=main_frame, site=guard.MNT)
        assert not guard.allowed_url(MNT_SEARCH, main_frame=main_frame, site=guard.AUTO24)
        assert not guard.allowed_url(MNT_SEARCH, main_frame=main_frame)
