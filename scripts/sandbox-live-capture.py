"""One live capture with a reveal, run inside the network sandbox.

Prints only statuses, never revealed registration numbers or VINs.
"""

import argparse
import os
from pathlib import Path

from auto24_service.browser import CaptureError, capture_listing
from auto24_service.captcha.solver import load_solver


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    solver = load_solver(Path(os.environ.get("CAPTCHA_SOLVER_DIR", "/opt/captcha-solver")))
    try:
        result = capture_listing(args.url, solver=solver)
    except CaptureError as exc:
        print(f"capture failed: {exc}")
        return 1
    registration = result.registration
    if registration is None:
        print("registration: none")
    else:
        print(f"reg_number_status: {registration.reg_number_status}")
        print(f"vin_status: {registration.vin_status}")
    attempts = result.reveal_diagnostics.attempts if result.reveal_diagnostics else []
    print(f"reveal attempts: {len(attempts)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
