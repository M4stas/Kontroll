"""Repeat live Transpordiamet background-check lookups and log each outcome.

Plates come from MNT_DRILL_PLATES (comma separated) and are never printed or logged;
each run names its plate by slot (A, B, ...). Writes runs.jsonl and summary.txt.
"""

import argparse
import json
import os
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from auto24_service.mnt_lookup import LookupFailed, lookup_background_check


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--pause-seconds", type=float, default=15)
    parser.add_argument("--deadline-seconds", type=float, default=240, help="the worker's lease length")
    parser.add_argument("--out", default="/app/benchmarks")
    parser.add_argument("--debug", action="store_true", help="save masked screenshots of each lookup event")
    args = parser.parse_args()
    plates = [p.strip() for p in os.environ.get("MNT_DRILL_PLATES", "").split(",") if p.strip()]
    if not plates:
        parser.error("set MNT_DRILL_PLATES")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = Path(args.out) / f"mnt-drill-{stamp}"
    out.mkdir(parents=True)
    log = (out / "runs.jsonl").open("a")
    rows = []
    for i in range(args.runs):
        slot = chr(ord("A") + i % len(plates))
        start = time.monotonic()
        row = {"run": i + 1, "plate": slot, "started_at": datetime.now(timezone.utc).isoformat()}
        events: list[str] = []
        row["events"] = events
        try:
            outcome = lookup_background_check(
                "reg_number", plates[i % len(plates)], start + args.deadline_seconds,
                debug_dir=out / f"run-{i + 1:02d}" if args.debug else None,
                on_debug=lambda event, page: events.append(event),
            )
            row |= {"status": outcome.status, "reason": outcome.reason,
                    "searched_by": outcome.searched_by, "pdf_bytes": len(outcome.pdf or b"")}
        except LookupFailed as exc:
            row |= {"status": "unavailable", "reason": exc.reason, "searched_by": exc.searched_by}
        except Exception as exc:
            row |= {"status": "error", "reason": type(exc).__name__}
        row["seconds"] = round(time.monotonic() - start, 1)
        rows.append(row)
        log.write(json.dumps(row) + "\n")
        log.flush()
        print(f"[{i + 1}/{args.runs}] plate {slot}: {row['status']}"
              f"{' ' + str(row['reason']) if row.get('reason') else ''} in {row['seconds']} s"
              f"{' events=' + ','.join(events) if events else ''}", flush=True)
        if i + 1 < args.runs:
            time.sleep(args.pause_seconds)
    counts = Counter(f"{r['status']}{'/' + str(r['reason']) if r.get('reason') else ''}" for r in rows)
    fetched = sorted(r["seconds"] for r in rows if r["status"] == "fetched")
    lines = [f"runs: {len(rows)}", *(f"{k}: {v}" for k, v in counts.most_common())]
    if fetched:
        lines.append(f"fetched seconds: min {fetched[0]} median {fetched[len(fetched) // 2]} max {fetched[-1]}")
    (out / "summary.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines), f"\nlog: benchmarks/{out.name}", sep="\n", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
