# Invisible worker dependencies

Audited 2026-10-29: invisible_playwright 0.43.0 and invisible_core 53.48.0; engine tag firefox-53. Requirements cover CPython 3.12 Linux arm64 and amd64 wheels.

In invisible_core 53.48.0, `download.py` lines 686–692 compare the downloaded archive's SHA-256 with the seal's SHA-256 and raise on mismatch.

The engine includes a GitHub usage ping (launch counter), and retail Firefox
background services contact Mozilla and other hosts. `INVISIBLE_QUIET_PREFS` in
`browser_invisible.py` disables the ping and background traffic;
`network.dns.localDomains` catches named Remote Settings and telemetry hosts that
ignore those prefs. The launch IP discovery call is disabled separately.
After every dependency or engine version bump, rerun
`scripts/network-sandbox offline --engine invisible` and require PASS with
`contacted hosts: none`: the prefs and localDomains match by name, so renaming
a pref or host can restore traffic silently.

To regenerate, use a disposable Python 3.12 container and `pip download --only-binary=:all: --python-version 3.12` for each of `manylinux2014_aarch64` / `manylinux_2_17_aarch64` and `manylinux2014_x86_64` / `manylinux_2_17_x86_64`, with the direct pins in the existing files. Resolve runtime and test sets separately, pin every resolved dependency, and use `pip hash` in the container to collect both architecture hashes. Review dependency and engine changes before updating the files.
