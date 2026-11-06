#!/bin/sh
# Warn when a branch is large, because every no-mistakes review round reads its whole diff.
# Usage: check-branch-size.sh [base-ref]. It always exits 0, so it can never block a push.
base=$(git merge-base HEAD "${1:-origin/main}" 2>/dev/null) || exit 0
stats=$(git diff --numstat "$base" HEAD -- . ':(exclude)pnpm-lock.yaml' 2>/dev/null) || exit 0
counts=$(printf '%s\n' "$stats" | awk 'NF { files++; if ($1 != "-" && $2 != "-") lines += $1 + $2 } END { print files + 0, lines + 0 }') || exit 0
set -- $counts
if [ "$1" -gt 15 ] || [ "$2" -gt 500 ]; then
  printf '%s\n' "Warning: branch has $1 files (limit 15) and $2 changed lines (limit 500). no-mistakes reviews the whole branch diff on every round, so consider splitting the branch." >&2
fi
exit 0
