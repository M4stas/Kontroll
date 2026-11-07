# Agent shell habits

The shell's working directory resets between commands, so a `cd` does not last.

## Worktrees

Start the session inside the worktree. When you drive a worktree from another checkout, name its path in each command:

- `git -C /abs/path/to/worktree status`
- `pnpm --dir /abs/path/to/worktree test`
- absolute file paths for reads and edits

Before you remove a worktree, run `lsof +D /abs/path/to/worktree`. Any output means a dev server, worker or terminal still runs there, so leave that worktree in place.

Create new worktrees under `.claude/worktrees/<name>`; `.worktrees/`, `~/.codex/worktrees` and `~/.t3` hold older ones. A session that runs in a worktree may edit only that worktree, and the app refuses writes to any other checkout.

## Dev servers

`.claude/launch.json` lives in the main checkout and every session shares it. Add a configuration only for a server you are starting now, name it after its worktree, and remove it when you stop the server.

## Long runs

Start builds, suites, and benchmarks in a linked Terminal tab with `run_in_terminal`, so the user can watch them, and tee the output to a log. Use `run_in_background` only when a tab is not possible; the completion notification wakes you. If a run needs a Monitor, emit a line only on a step change, a failure, or the finish. For a condition with no process to end, such as a server coming up, use a Monitor until-loop. `read_terminal` waits at most 300 s, so watch a longer terminal run with Monitor.

Each `run_in_terminal` call opens in the main checkout, so start its command with `cd /abs/path/to/worktree &&`. A tab id goes stale when its shell exits, so call `list_terminal_tabs` before reusing one.

## Quoting

zsh treats `?`, `*` and `[` as globs, so quote any URL or API path that contains them: `gh api 'repos/o/r/issues?state=all'`.

## Browser output

Read a page with `get_page_text` or `read_page`. Take screenshots at `scale: 0.5`, and go to full size only when the check is visual detail such as spacing or color.
