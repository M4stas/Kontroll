"""Summarize the network sandbox's tshark field lines into a pass or fail result.

Each line is `|`-separated: frame time, IPv4 source, IPv4 destination,
IPv6 source, IPv6 destination,
TCP destination port, UDP destination port, DNS response flag, DNS query
names, DNS A answers, DNS AAAA answers and TLS server name. The logging container writes one line per DNS
packet, TLS client hello, TCP SYN and non-DNS UDP packet.

The capture sees both directions. The IPv4 and IPv6 source columns are
recorded for human readers only. Inbound is decided by the outer destination:
a packet whose first destination is one of the container's own non-loopback
addresses is an inbound reply and is not judged. Without the own-address list
the result is FAIL. A line with the wrong number of fields, or with both IPv4
and IPv6 addresses (a tunnelled packet), is a problem and fails the run.
"""

from __future__ import annotations

import argparse
import ipaddress
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

ALLOWED_LIVE_HOSTS = frozenset({"www.auto24.ee", "www.google.com", "www.gstatic.com"})
REQUIRED_LIVE_HOST = "www.auto24.ee"
# Offline runs look this name up once after logging starts, to prove the log works.
CANARY_HOST = "sandbox-canary.invalid"
DOCKER_DNS = "127.0.0.11"
FIELD_COUNT = 12


@dataclass
class SandboxReport:
    mode: str
    hosts: list[str] = field(default_factory=list)
    unnamed_ips: list[str] = field(default_factory=list)
    passed: bool = False
    problems: list[str] = field(default_factory=list)


def _split(value: str) -> list[str]:
    return [part.strip().rstrip(".").lower() for part in value.split(",") if part.strip()]


def _is_loopback(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def summarize(
    lines: Iterable[str], mode: Literal["offline", "live"], own_addresses: Iterable[str] | None = None
) -> SandboxReport:
    own = {a for a in _split(",".join(own_addresses or [])) if not _is_loopback(a)}
    hosts: set[str] = set()
    names_by_ip: dict[str, str] = {}
    contacted: list[str] = []
    problems: list[str] = []
    canary_seen = False
    if not own:
        problems.append("own-address list missing or empty; cannot tell inbound from outbound")
    for raw in lines:
        if not raw.strip():
            continue
        parts = raw.rstrip("\r\n").split("|")
        if len(parts) != FIELD_COUNT:
            problems.append(f"malformed line (expected {FIELD_COUNT} fields)")
            continue
        _, src4, dst4, src6, dst6, tcp_port, udp_port, is_response, queries, answers, answers6, sni = (
            p.strip() for p in parts
        )
        if (src4 or dst4) and (src6 or dst6):
            problems.append("packet with both IPv4 and IPv6 addresses (tunnelled); cannot judge direction")
            continue
        dst = _split(dst4)[:1] or _split(dst6)[:1]
        dst = dst[0] if dst else ""
        # Comma-joined values come from ICMP or tunnels; the first is the outer header.
        if dst and dst in own:
            continue
        if is_response in {"1", "True", "true"}:
            for query in _split(queries)[:1]:
                for ip in _split(answers) + _split(answers6):
                    names_by_ip[ip] = query
            continue
        if not dst:
            if tcp_port or udp_port or sni or queries:
                problems.append("packet with a port or name but no destination address")
            continue
        names = [n for n in _split(queries) if n != CANARY_HOST]
        if CANARY_HOST in _split(queries):
            canary_seen = True
        if queries:
            hosts.update(names)
            if not _is_loopback(dst):
                contacted.append(dst)
            continue
        if sni:
            hosts.update(_split(sni))
            names_by_ip[dst] = _split(sni)[0]
            continue
        if dst == DOCKER_DNS:
            problems.append(f"packet to {DOCKER_DNS} without a decoded DNS name")
            continue
        if _is_loopback(dst):
            continue
        contacted.append(dst)
    unnamed = sorted({ip for ip in contacted if ip not in names_by_ip})
    for ip in contacted:
        if ip in names_by_ip:
            hosts.add(names_by_ip[ip])
    sorted_hosts = sorted(hosts)
    if mode == "offline":
        if not canary_seen:
            problems.append(f"canary query for {CANARY_HOST} not recorded; the log is not working")
        passed = not sorted_hosts and not unnamed and not contacted and not problems
    else:
        if REQUIRED_LIVE_HOST not in hosts:
            problems.append(f"{REQUIRED_LIVE_HOST} not recorded; the capture or the log did not work")
        passed = not unnamed and not problems and set(sorted_hosts) <= ALLOWED_LIVE_HOSTS
    return SandboxReport(
        mode=mode, hosts=sorted_hosts, unnamed_ips=unnamed, passed=passed, problems=sorted(set(problems))
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a network sandbox traffic log.")
    parser.add_argument("mode", choices=["offline", "live"])
    parser.add_argument("traffic_file")
    parser.add_argument("--own-addresses", help="file listing the capture container's own addresses")
    args = parser.parse_args(argv)
    with open(args.traffic_file, encoding="utf-8", errors="replace") as handle:
        own: list[str] = []
        if args.own_addresses:
            try:
                with open(args.own_addresses, encoding="utf-8") as own_handle:
                    own = [line.strip() for line in own_handle if line.strip()]
            except OSError:
                own = []
        report = summarize(handle, args.mode, own)
    print("PASS" if report.passed else "FAIL")
    if args.mode == "live":
        print("allowed hosts: " + ", ".join(sorted(ALLOWED_LIVE_HOSTS)))
    print("contacted hosts:" + ("" if report.hosts else " none"))
    for host in report.hosts:
        print(f"  {host}")
    for problem in report.problems:
        print(f"problem: {problem}")
    if report.unnamed_ips:
        print("connections with no DNS name or TLS server name:")
        for ip in report.unnamed_ips:
            print(f"  {ip}")
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
