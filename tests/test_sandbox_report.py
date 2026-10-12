from auto24_service.sandbox_report import ALLOWED_LIVE_HOSTS, summarize

# Fields: time | ip.dst | tcp.dstport | udp.dstport | dns.flags.response | dns.qry.name | dns.a | tls sni
LOOPBACK_NOISE = "1.0|127.0.0.1|9222||||||"


def test_offline_passes_with_no_outgoing_traffic():
    report = summarize(["", LOOPBACK_NOISE], "offline")
    assert report.passed
    assert report.hosts == []
    assert report.unnamed_ips == []


def test_offline_fails_on_any_dns_query():
    report = summarize(["1.0|127.0.0.11||53|0|detectportal.firefox.com||"], "offline")
    assert not report.passed
    assert report.hosts == ["detectportal.firefox.com"]


def test_live_passes_with_only_allowed_hosts():
    lines = [
        "1.0|127.0.0.11||53|0|www.auto24.ee||",
        "1.1|172.18.0.2||40000|1|www.auto24.ee|1.2.3.4|",
        "1.2|1.2.3.4|443|||||www.auto24.ee",
        "1.3|127.0.0.11||53|0|www.google.com||",
        "1.4|172.18.0.2||40001|1|www.google.com|5.6.7.8,5.6.7.9|",
        "1.5|5.6.7.9|443||||",
        "1.6|9.9.9.9|443|||||www.gstatic.com",
    ]
    report = summarize(lines, "live")
    assert report.passed, report
    assert report.hosts == sorted(ALLOWED_LIVE_HOSTS)
    assert report.unnamed_ips == []


def test_live_fails_on_extra_host():
    lines = ["1.0|127.0.0.11||53|0|www.auto24.ee||", "1.1|8.8.8.8|443|||||firefox.settings.services.mozilla.com"]
    report = summarize(lines, "live")
    assert not report.passed
    assert "firefox.settings.services.mozilla.com" in report.hosts


def test_connection_without_dns_name_or_sni_fails():
    report = summarize(["1.0|203.0.113.7|443||||"], "live")
    assert not report.passed
    assert report.unnamed_ips == ["203.0.113.7"]
    assert summarize(["1.0|203.0.113.7||443|||"], "offline").unnamed_ips == ["203.0.113.7"]
