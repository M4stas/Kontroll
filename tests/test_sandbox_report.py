from auto24_service.sandbox_report import ALLOWED_LIVE_HOSTS, CANARY_HOST
from auto24_service.sandbox_report import summarize as _summarize


OWN = ["127.0.0.1", "172.28.0.2", "::1"]


def line(dst="", dst6="", tcp="", udp="", response="", query="", a="", aaaa="", sni="", src="", src6=""):
    return "|".join(["1.0", src, dst, src6, dst6, tcp, udp, response, query, a, aaaa, sni])


def summarize(lines, mode, own_addresses=OWN):
    return _summarize(lines, mode, own_addresses)


CANARY = line("127.0.0.11", udp="53", response="0", query=CANARY_HOST)
LIVE_OK = [
    line("127.0.0.11", udp="53", response="0", query="www.auto24.ee"),
    line("127.0.0.1", udp="40000", response="1", query="www.auto24.ee", a="1.2.3.4"),
    line("1.2.3.4", tcp="443", sni="www.auto24.ee"),
]


def test_offline_passes_with_no_outgoing_traffic():
    report = summarize(["", line("127.0.0.1", tcp="9222"), CANARY], "offline")
    assert report.passed
    assert report.hosts == []
    assert report.unnamed_ips == []


def test_offline_fails_without_canary():
    report = summarize([], "offline")
    assert not report.passed


def test_offline_fails_on_any_dns_query():
    report = summarize([CANARY, line("127.0.0.11", udp="53", response="0", query="detectportal.firefox.com")], "offline")
    assert not report.passed
    assert report.hosts == ["detectportal.firefox.com"]


def test_live_passes_with_only_allowed_hosts():
    lines = LIVE_OK + [
        line("127.0.0.11", udp="53", response="0", query="www.google.com"),
        line("127.0.0.1", udp="40001", response="1", query="www.google.com", a="5.6.7.8,5.6.7.9"),
        line("5.6.7.9", tcp="443"),
        line("9.9.9.9", tcp="443", sni="www.gstatic.com"),
    ]
    report = summarize(lines, "live")
    assert report.passed, report
    assert report.hosts == sorted(ALLOWED_LIVE_HOSTS)
    assert report.unnamed_ips == []


def test_live_fails_on_empty_file():
    assert not summarize([], "live").passed


def test_live_fails_on_loopback_only_traffic():
    assert not summarize([line("127.0.0.1", tcp="9222")], "live").passed


def test_live_fails_on_extra_host():
    lines = LIVE_OK + [line("8.8.8.8", tcp="443", sni="firefox.settings.services.mozilla.com")]
    report = summarize(lines, "live")
    assert not report.passed
    assert "firefox.settings.services.mozilla.com" in report.hosts


def test_connection_without_dns_name_or_sni_fails():
    report = summarize(LIVE_OK + [line("203.0.113.7", tcp="443")], "live")
    assert not report.passed
    assert report.unnamed_ips == ["203.0.113.7"]
    assert summarize([CANARY, line("203.0.113.7", udp="443")], "offline").unnamed_ips == ["203.0.113.7"]


def test_quic_without_sni_fails():
    report = summarize(LIVE_OK + [line("1.2.3.5", udp="443")], "live")
    assert not report.passed
    assert report.unnamed_ips == ["1.2.3.5"]


def test_ipv6_connection_is_seen():
    report = summarize(LIVE_OK + [line(dst6="2001:db8::1", tcp="443")], "live")
    assert not report.passed
    assert report.unnamed_ips == ["2001:db8::1"]
    named = LIVE_OK + [
        line(dst6="fd00::1", udp="40002", response="1", query="www.google.com", aaaa="2001:db8::2"),
        line(dst6="2001:db8::2", tcp="443"),
    ]
    assert summarize(named, "live").passed


def test_line_with_port_but_no_destination_fails():
    report = summarize(LIVE_OK + [line(tcp="443")], "live")
    assert not report.passed


def test_dns_query_to_outside_resolver_counts_resolver():
    report = summarize(LIVE_OK + [line("8.8.8.8", udp="53", response="0", query="www.auto24.ee")], "live")
    assert not report.passed
    assert "8.8.8.8" in report.unnamed_ips


def test_undecoded_packet_to_docker_dns_fails():
    report = summarize(LIVE_OK + [line("127.0.0.11", udp="53")], "live")
    assert not report.passed


QUIC_NAMED = [
    line("127.0.0.11", udp="53", response="0", query="www.google.com"),
    line("127.0.0.1", udp="40000", response="1", query="www.google.com", a="172.64.144.236"),
    line("172.64.144.236", udp="443", src="172.28.0.2"),
]


def test_inbound_udp_to_own_address_is_ignored():
    inbound = line("172.28.0.2", udp="54445", src="172.64.144.236")
    report = summarize(LIVE_OK + QUIC_NAMED + [inbound] * 3, "live")
    assert report.passed, report
    assert report.unnamed_ips == []
    assert report.hosts == ["www.auto24.ee", "www.google.com"]


def test_outbound_to_unnamed_ip_still_fails_with_own_addresses():
    report = summarize(LIVE_OK + [line("9.9.9.9", udp="443", src="172.28.0.2")], "live")
    assert not report.passed
    assert report.unnamed_ips == ["9.9.9.9"]


def test_comma_joined_destination_judges_outer_header():
    # ICMP from this container to a named remote, quoting an inbound reply.
    icmp = line("172.64.144.236,172.28.0.2", udp="54445", src="172.28.0.2,172.64.144.236")
    assert summarize(LIVE_OK + QUIC_NAMED + [icmp], "live").passed
    unnamed = line("9.9.9.9,172.28.0.2", udp="54445", src="172.28.0.2,9.9.9.9")
    report = summarize(LIVE_OK + [unnamed], "live")
    assert not report.passed
    assert report.unnamed_ips == ["9.9.9.9"]


def test_missing_own_address_list_fails():
    assert not summarize(LIVE_OK, "live", None).passed
    assert not summarize(LIVE_OK, "live", []).passed
    assert not summarize(LIVE_OK, "live", ["127.0.0.1", "::1"]).passed
    assert not summarize([CANARY], "offline", []).passed
