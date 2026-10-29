"""Firefox preferences shared by the Camoufox and invisible browser launches.

This module imports nothing, so the invisible image can use it without the
Camoufox stack.
"""

# Firefox preferences that stop background traffic the capture never asked for.
# The network sandbox (scripts/network-sandbox offline) records any that remain.
QUIET_FIREFOX_PREFS = {
    "network.dns.disablePrefetch": True,
    "network.dns.disablePrefetchFromHTTPS": True,
    "network.prefetch-next": False,
    "network.predictor.enabled": False,
    "network.http.speculative-parallel-limit": 0,
    "browser.places.speculativeConnect.enabled": False,
    "browser.urlbar.speculativeConnect.enabled": False,
}
