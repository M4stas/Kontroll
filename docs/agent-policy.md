# Development agent policy

This is the single authority for development-agent allocations in this project and its worktrees. Updated October 2, 2026, from the user's latest assignments. Direct user instructions take precedence; record future allocation changes here only.

| Role | Model | Thinking level |
|---|---|---|
| Coordinator and planner | `gpt-6.1-sol` | `low` |
| File searches and simple triage | `gpt-6-luna` | `low` |
| Small implementation changes and focused tests | `gpt-6.1-sol` | `low` |
| Integration, database work, and debugging | `gpt-6.1-sol` | `low` |
| Independent code review | `gpt-6.1-sol` | `low` |
| Final review of migrations, privacy, or concurrency | `gpt-6.1-sol` | `medium` |
| Semantic model evaluations | `gpt-6.1-sol` | `low` |
| Manual frontend E2E and demo testing | `gpt-6-luna` | `low` |
| Other roles without an explicit assignment | Inherit the current chat's model | Inherit within the effort limit below |

Use the assigned model and thinking level explicitly when dispatching an allocated role. Recommendations do not change an allocation until the user adopts them. When allocations change, update this file before dispatching future agents. Keep exceptions out of plans.

Keep Luna's tasks small and clearly specified. Give each Luna agent one narrow task with named files, expected behavior, and acceptance checks. Split larger work into independent slices; use the integration role for changes requiring judgment across components.

Never use max for any role. Sol uses low for small implementation changes and focused tests. Other roles use the table defaults; no default high or xhigh. After a failed attempt, raise Sol low to medium for a focused retry. Use high only when a difficult problem survives two attempted fixes. Inherited settings follow these limits.

Dispatch agents with compact task briefs, named files, and acceptance checks. Pass only relevant context instead of the full conversation history.

Keep concurrent writers on separate files. Prefer independent subagents for reviews and testing. The coordinator owns scope, integration, acceptance evidence, and checkpoint delivery.

Plans, task briefs, and ledgers must link to this policy rather than repeat its allocation table. Historical execution reports may retain the actual model and thinking level used, clearly identified as historical evidence rather than instructions for future dispatches.

These assignments govern development agents. The app's DataReviewer model, provider, prompts, and reasoning settings remain in the server runtime configuration. User-wide Codex defaults remain in the user's Codex configuration.
