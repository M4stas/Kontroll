# Agent shell habits

The shell's working directory resets between commands, so a `cd` does not last.

## Worktrees

Start the session inside the worktree. When you drive a worktree from another checkout, name its path in each command:

- `git -C /abs/path/to/worktree status`
- `pnpm --dir /abs/path/to/worktree test`
- absolute file paths for reads and edits

## Long runs

Start builds, suites, and benchmarks with `run_in_background`. The completion notification wakes you, so do other work meanwhile. For a condition with no process to end, such as a server coming up, use a Monitor until-loop.

## Browser output

Read a page with `get_page_text` or `read_page`. Take screenshots at `scale: 0.5`, and go to full size only when the check is visual detail such as spacing or color.
