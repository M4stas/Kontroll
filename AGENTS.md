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

## Planning checkpoints

Split every plan, spec, or roadmap into checkpoints that each end with a change the user can see in the running app. After each checkpoint, the user runs the app, checks the result, and then decides whether to approve the next one.

- Give each checkpoint a "What you will see" section and a numbered "How to check" section with steps the user can follow in the app.
- Put work with no visible result, such as plan updates or spec decisions, in a "Before starting" step of the first checkpoint that needs it. Do not make it a checkpoint of its own.
- Keep tasks only the user can do, such as human model review, outside the numbered checkpoints.
- Stop after each checkpoint. Finishing one does not approve the next.

[Roadmap](docs/superpowers/roadmap.md) shows the format.
