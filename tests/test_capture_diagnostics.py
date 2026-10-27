from contextlib import contextmanager
import pytest
from test_browser import FakePage, install_fake_browser, browser, LISTING_URL
from auto24_service.opener import ListingOpener

class Observer:
    def __init__(self): self.events = []
    @contextmanager
    def phase(self, name):
        try: yield
        except BaseException:
            self.events.append((name, "failed"))
            raise
        else: self.events.append((name, "complete"))

def test_capture_reports_phases_in_order(monkeypatch):
    install_fake_browser(monkeypatch, FakePage())
    observer = Observer()
    browser.capture_html(LISTING_URL, observer)
    assert observer.events == [(name, "complete") for name in ["browser_start", "page_setup", "navigation", "validation", "html_retrieval", "validation", "browser_shutdown"]]

def test_navigation_failure_marks_navigation_failed_and_still_shuts_down(monkeypatch):
    page = FakePage()
    def fail(*args, **kwargs): raise RuntimeError("timeout")
    page.goto = fail
    install_fake_browser(monkeypatch, page)
    observer = Observer()
    with pytest.raises(browser.CaptureError, match="temporary_failure"):
        browser.capture_html(LISTING_URL, observer)
    assert observer.events[-2:] == [("navigation", "failed"), ("browser_shutdown", "complete")]

def test_listing_gone_marks_validation_failed(monkeypatch):
    install_fake_browser(monkeypatch, FakePage(status=404))
    observer = Observer()
    with pytest.raises(browser.CaptureError, match="listing_gone"):
        browser.capture_html(LISTING_URL, observer)
    assert ("validation", "failed") in observer.events
    assert observer.events[-1] == ("browser_shutdown", "complete")

def test_capture_listing_reports_first_session_phases_around_the_reveal(monkeypatch):
    from types import SimpleNamespace
    install_fake_browser(monkeypatch, FakePage())
    observer = Observer()
    def reveal(*_args, **_kwargs):
        observer.events.append(("reveal", "ran"))
        from auto24_service.contracts import RevealDiagnostics
        return SimpleNamespace(registration=None, diagnostics=RevealDiagnostics())
    result = browser.capture_listing(LISTING_URL, solver=None, reveal=reveal, observer=observer)
    assert result.html == "<main>listing</main>"
    assert observer.events == [(name, "complete") for name in ["browser_start", "page_setup", "navigation", "validation", "html_retrieval", "validation"]] + [("reveal", "ran"), ("browser_shutdown", "complete")]


def test_capture_listing_passes_the_observer_to_the_opener():
    from contextlib import contextmanager
    from types import SimpleNamespace
    from auto24_service.contracts import RevealDiagnostics
    seen = {}
    @contextmanager
    def opener(url, *, profile_dir, deadline, keep_profile, observer):
        seen["observer"] = observer
        yield SimpleNamespace(page=SimpleNamespace(content=lambda: "<main>listing</main>"), main_frame_blocked=False)
    reveal = lambda *a, **k: SimpleNamespace(registration=None, diagnostics=RevealDiagnostics())
    observer = Observer()
    browser.capture_listing(LISTING_URL, solver=None, opener=ListingOpener(opener, same_thread=False), reveal=reveal,
                            observer=observer, engine="chromium")
    assert seen["observer"] is observer
    assert observer.events == [("html_retrieval", "complete"), ("validation", "complete")]
