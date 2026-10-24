# Development agent policy

This is the single authority for development-agent allocations in this project and its worktrees. Updated October 24, 2026, from the user's latest assignments. The Claude section was added October 11, 2026. Direct user instructions take precedence; record future allocation changes here only.

Use the Codex table when the coordinator runs in Codex and the Claude table when it runs in Claude Code. Each table lists the same roles. Do not mix the two in one dispatch.

## Codex agents

| Role | Model | Thinking level |
|---|---|---|
| Coordinator and planner | `gpt-6.1-sol` | `low` |
| File searches and simple triage | `gpt-6-luna` | `low` |
| Small implementation changes and focused tests | `gpt-6.1-sol` | `low` |
| Integration, database work, and debugging | `gpt-6.1-sol` | `low` |
| Independent code review | `gpt-6.1-sol` | `low` |
| Final review of migrations, privacy, or concurrency | `gpt-6.1-sol` | `medium` |
| Semantic model evaluations | `gpt-6.1-sol` | `low` |
| Manual frontend E2E and demo testing | Coordinator runs it: `gpt-6.1-sol` | `low` |
| Other roles without an explicit assignment | Inherit the current chat's model | Inherit within the effort limit below |

The coordinator runs manual frontend E2E and demo testing itself, because Codex child sessions have no browser.

Keep Luna's tasks small and clearly specified. Give each Luna agent one narrow task with named files, expected behavior, and acceptance checks. Split larger work into independent slices; use the integration role for changes requiring judgment across components.

Sol uses low for small implementation changes and focused tests. After a failed attempt, raise Sol low to medium for a focused retry.

## Claude agents

| Role | Model | Effort |
|---|---|---|
| Coordinator and planner | `claude-opus-5-5` | `low` |
| File searches and simple triage | `claude-haiku-5-5` | `low` |
| Small implementation changes and focused tests | `claude-sonnet-5-5` | `low` |
| Integration, database work, and debugging | `claude-opus-5-5` | `low` |
| Independent code review | `claude-opus-5-5` | `medium` |
| Final review of migrations, privacy, or concurrency | `claude-opus-5-5` | `xhigh` |
| Semantic model evaluations | `claude-opus-5-5` | `low` |
| Manual frontend E2E and demo testing | `claude-sonnet-5-5` | `low` |
| Other roles without an explicit assignment | Inherit the current chat's model | Inherit within the effort limit below |

In Claude Code's Agent tool, pass the model as `opus`, `sonnet` or `haiku` and the effort level as `effort`. Built-in agent types that fix their own model, such as `Explore`, may be used for file searches when their model is Haiku or smaller.

Keep Haiku's tasks small and clearly specified, under the same rules as Luna's above.

Sonnet uses low for small implementation changes and focused tests. After a failed attempt, raise the same agent's effort from low to medium for a focused retry. If a Sonnet task fails twice, hand it to Opus at low.

The table maps the Codex roles this way: tasks given to Sol go to Opus, except small implementation changes, which go to Sonnet because a narrow, well-specified task does not need Opus. Tasks given to Luna go to Haiku. Manual E2E and demo testing has no Luna counterpart, because the Codex coordinator runs it; the Claude table sends it to Sonnet because driving a browser through a multi-step flow is beyond what Haiku does reliably.

## Rules for both

Never use max for any role. Other roles use the table defaults; no default high or xhigh, except the Claude final review of migrations, privacy, or concurrency, which uses xhigh. Otherwise use high only when a difficult problem survives two attempted fixes. Inherited settings follow these limits.

Use the assigned model and thinking level or effort explicitly when dispatching an allocated role. Recommendations do not change an allocation until the user adopts them. When allocations change, update this file before dispatching future agents. Keep exceptions out of plans.

Dispatch agents with compact task briefs, named files, and acceptance checks. Pass only relevant context instead of the full conversation history.

Keep concurrent writers on separate files. Prefer independent subagents for reviews and testing. The coordinator owns scope, integration, acceptance evidence, and checkpoint delivery.

Plans, task briefs, and ledgers must link to this policy rather than repeat its allocation tables. Historical execution reports may retain the actual model and thinking level or effort used, clearly identified as historical evidence rather than instructions for future dispatches.

These assignments govern development agents. The app's DataReviewer model, provider, prompts, and reasoning settings remain in the server runtime configuration. User-wide Codex defaults remain in the user's Codex configuration, and user-wide Claude Code defaults remain in the user's Claude Code settings.
