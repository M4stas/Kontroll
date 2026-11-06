<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Development agent policy

Read [development agent policy](docs/agent-policy.md) before assigning agents. It is the authority for models, thinking levels, and delegation rules. Keep allocation tables out of other project files.

## Local development

Use pnpm, never npm or npx: `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm test`. Run `corepack enable` once if `pnpm` is not found.

Use the shared local Supabase stack from `supabase/config.toml`. If you start a disposable stack under another project ID, remove it when you finish with `pnpm supabase stop --no-backup --project-id <id>`. Never stop or reset the shared stack.

[Local development](docs/local-development.md) has the full setup.

Before running shell commands against a worktree, starting a long run, or reading browser pages, read [agent shell habits](docs/agent-shell.md).

On the Mac, build Docker images for `linux/arm64`. Build `linux/amd64` only when the user asks; amd64 checks run on the x86_64 server.

## Planning checkpoints

Split every plan, spec, or roadmap into checkpoints that each end with a change visible in the running app.

- Give each checkpoint a "What you will see" section and a numbered "How to check" section with steps an agent can follow in the internal browser.
- Put work with no visible result, such as plan updates or spec decisions, in a "Before starting" step of the first checkpoint that needs it. Do not make it a checkpoint of its own.
- Keep tasks only the user can do, such as human model review, outside the numbered checkpoints.

## Checking a checkpoint

The agent that delivers a checkpoint checks it and signs it off.

1. Before merge, run every "How to check" step yourself in the internal browser against the running app, including live Auto24 and Transpordiamet lookups.
2. Record each step's result in the PR body. Every step, CI and the independent review must pass before merge.
3. Include the completion update in the checkpoint PR itself. Add or update its entry in the [completed work log](docs/superpowers/completed-work.md) with the checkpoint ID, summary, PR link, verification date, and links to the plan and check results. Update an existing implementation entry for the same checkpoint instead of duplicating it. Record a merge date only after GitHub confirms it.
4. In the same PR, remove the completed row and its checkpoint-only sections from the [main roadmap](docs/superpowers/roadmap.md) and [service roadmap](docs/superpowers/service-roadmap.md), wherever listed. Keep unfinished work and checks in the roadmaps, preserve checkpoint numbers, and update links to any moved sections. Partial implementation may enter the log, but its outstanding checks stay active. Verify the documentation links and required checks against the final PR changes.
5. After merge, confirm GitHub reports the PR as merged and that `main` contains the roadmap and log updates. Only then report the checkpoint complete and go straight on to the next checkpoint whose plan or spec is approved.

Stop and report to the user when a step fails and you cannot fix it, when a step cannot run (a missing service, a site outage), or when the next checkpoint is not approved.

[Roadmap](docs/superpowers/roadmap.md) shows the format. Before reporting roadmap progress, run `pnpm roadmap:status`: it checks each Status cell against GitHub and local branches, and flags stale rows to fix.
