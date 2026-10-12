"""Summarize the network sandbox's tshark field lines into a pass or fail result.

Each line is `|`-separated: frame time, destination IP, TCP destination port,
UDP destination port, DNS response flag, DNS query names, DNS answer
addresses and TLS server name. The logging container writes one line per DNS
packet, TLS client hello, TCP SYN and non-DNS UDP packet.
"""

from __future__ import annotations

import argparse
import ipaddress
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Literal

ALLOWED_LIVE_HOSTS = frozenset({"www.auto24.ee", "www.google.com", "www.gstatic.com"})
DOCKER_DNS = "127.0.0.11"


@dataclass
class SandboxReport:
    mode: str
    hosts: list[str] = field(default_factory=list)
    unnamed_ips: list[str] = field(default_factory=list)
    passed: bool = False


def _split(value: str) -> list[str]:
    return [part.strip().rstrip(".").lower() for part in value.split(",") if part.strip()]


def summarize(lines: Iterable[str], mode: Literal["offline", "live"]) -> SandboxReport:
    hosts: set[str] = set()
    names_by_ip: dict[str, str] = {}
    contacted: list[str] = []
    unnamed_dns = False
    for raw in lines:
        parts = (raw.rstrip("\n").split("|") + [""] * 8)[:8]
        _, dst, tcp_port, udp_port, is_response, queries, answers, sni = parts
        dst = dst.strip()
        if not dst:
            continue
        if is_response.strip() in {"1", "True", "true"}:
            for query in _split(queries)[:1]:
                for ip in _split(answers):
                    names_by_ip[ip] = query
            continue
        if queries.strip():
            hosts.update(_split(queries))
            continue
        if sni.strip():
            hosts.update(_split(sni))
            names_by_ip[dst] = _split(sni)[0]
            continue
        if dst == DOCKER_DNS:
            unnamed_dns = True
            continue
        try:
            if ipaddress.ip_address(dst).is_loopback:
                continue
        except ValueError:
            pass
        if tcp_port.strip() or udp_port.strip():
            contacted.append(dst)
    unnamed = sorted({ip for ip in contacted if ip not in names_by_ip})
    if unnamed_dns:
        unnamed.append(f"{DOCKER_DNS} (DNS query without a decoded name)")
    for ip in contacted:
        if ip in names_by_ip:
            hosts.add(names_by_ip[ip])
    sorted_hosts = sorted(hosts)
    if mode == "offline":
        passed = not sorted_hosts and not unnamed and not contacted
    else:
        passed = not unnamed and set(sorted_hosts) <= ALLOWED_LIVE_HOSTS
    return SandboxReport(mode=mode, hosts=sorted_hosts, unnamed_ips=unnamed, passed=passed)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a network sandbox traffic log.")
    parser.add_argument("mode", choices=["offline", "live"])
    parser.add_argument("traffic_file")
    args = parser.parse_args(argv)
    with open(args.traffic_file, encoding="utf-8", errors="replace") as handle:
        report = summarize(handle, args.mode)
    print("PASS" if report.passed else "FAIL")
    if args.mode == "live":
        print("allowed hosts: " + ", ".join(sorted(ALLOWED_LIVE_HOSTS)))
    print("contacted hosts:" + ("" if report.hosts else " none"))
    for host in report.hosts:
        print(f"  {host}")
    if report.unnamed_ips:
        print("connections with no DNS name or TLS server name:")
        for ip in report.unnamed_ips:
            print(f"  {ip}")
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
