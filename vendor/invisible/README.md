# Invisible worker dependencies

Audited 2026-10-29: invisible_playwright 0.43.0 and invisible_core 53.48.0; engine tag firefox-53. Requirements cover CPython 3.12 Linux arm64 and amd64 wheels.

To regenerate, use a disposable Python 3.12 container and `pip download --only-binary=:all: --python-version 3.12` for each of `manylinux2014_aarch64` / `manylinux_2_17_aarch64` and `manylinux2014_x86_64` / `manylinux_2_17_x86_64`, with the direct pins in the existing files. Resolve runtime and test sets separately, pin every resolved dependency, and use `pip hash` in the container to collect both architecture hashes. Review dependency and engine changes before updating the files.
