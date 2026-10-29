# Development agent policy

This is the single authority for development-agent allocations in this project and its worktrees. Codex allocations updated October 26, 2026, after the GPT-6.1 Terra release. The Claude section was added October 11, 2026. Direct user instructions take precedence; record future allocation changes here only.

The provider-local tables below list the same roles. Apply [cross-provider routing](#cross-provider-routing) first, then use the selected provider's table for model and effort defaults unless that section overrides them.

## Codex agents

| Role | Model | Thinking level |
|---|---|---|
| Coordinator and planner | `gpt-6.1-sol` | `low` |
| File searches and simple triage | `gpt-6-luna` | `low` |
| Small implementation changes and focused tests | `gpt-6.1-terra` | `low` |
| Integration, database work, and debugging | `gpt-6.1-sol` | `low` |
| Independent code review | `gpt-6.1-sol` | `low` |
| Final review of migrations, privacy, or concurrency | `gpt-6.1-sol` | `medium` |
| Semantic model evaluations | `gpt-6.1-sol` | `low` |
| Manual frontend E2E and demo testing | Coordinator runs it: `gpt-6.1-sol` | `low` |
| Other roles without an explicit assignment | Inherit the current chat's model | Inherit within the effort limit below |

Keep Luna's tasks small and clearly specified. Give each Luna agent one narrow task with named files, expected behavior, and acceptance checks. Split larger work into independent slices; use the integration role for changes requiring judgment across components.

Give Terra small changes with named files and acceptance checks. After a failed attempt, raise Terra low to medium for one focused retry. If that retry fails or the task needs judgment across components, hand it to Sol low. After a failed Sol attempt, raise Sol low to medium for a focused retry.

The coordinator runs manual frontend E2E and demo testing itself, because Codex child sessions have no browser. Use the internal browser first.

### Model selection evidence

Checked October 26, 2026. [Artificial Analysis](https://artificialanalysis.ai/articles/gpt-6-1-terra-pushes-the-cost-efficiency-frontier) reports Coding Agent Index scores of 48 for Terra, 54 for Sol, and 31 for Luna. These headline results do not establish the same ordering at low effort. Terra low is on the coding cost-efficiency frontier; low and medium are on the Intelligence Index cost-efficiency frontier.

Standard API prices per million input/output tokens are $1/$5 for [Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), $2/$10 for [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and $0.10/$0.50 for [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). API prices do not establish ChatGPT plan usage costs. Artificial Analysis has no Terra speed measurement yet, so this policy assumes no measured latency advantage.

The recommendation is to use Terra for scoped implementation, keep Luna for searches, and retain Sol for coordination, integration, reviews, and semantic evaluations. [OpenAI's model guidance](https://developers.openai.com/api/docs/guides/model-selection) also identifies scoped code fixes and computer use as Terra use cases. These are starting allocations, not validation on this repository. Compare completion quality, repair time, and provider usage on representative tasks before expanding Terra's role. Keep the existing effort limits, including the max prohibition.

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

The table maps the Codex roles this way: tasks given to Sol go to Opus, tasks given to Terra go to Sonnet, and tasks given to Luna go to Haiku. Manual E2E and demo testing stays with the Codex coordinator; the Claude table assigns it to Sonnet. Cross-provider routing below overrides these provider-local defaults.

## Cross-provider routing

Added October 24, 2026. A coordinator in either tool may dispatch to both providers.

- Backend work (server, database, pipeline, integration, migrations) goes to Codex. Use `gpt-6.1-terra` for small implementation changes and focused tests, and `gpt-6.1-sol` for integration, database work, debugging, and migrations. Pass the table's model and thinking level with `codex exec -m <model> -c model_reasoning_effort=<level>`.
- Frontend work (UI, components, styling, browser E2E) goes to Claude `opus`.
- Claude's plan runs out faster than Codex's, and most of its use comes from reviews. Send searches, triage and other read-only helper tasks to Codex `gpt-6-luna` rather than a Claude subagent, unless the coordinator needs the answer inside this turn's context.
- Each finished implementation task gets an independent review from the other provider: Codex work, including Terra's, is reviewed by Opus, and Opus's work by Sol. Opus reviews per task and re-reviews use `medium`, even for migrations or concurrency; reserve `xhigh` for the one final whole-branch review before merge. Give Opus a scoped diff and a short brief.
- Before each dispatch, follow the `dispatch-routing` skill (`~/.claude/skills/dispatch-routing/SKILL.md`). It reads both usages and applies the rules in this section.
- If the preferred provider's 5-hour window is at least 85% used, or its weekly use is ahead of an even pace to the weekly reset, send the task to the other provider instead. If both are tight, queue the task and say so.
- If one provider's weekly window will reset with a lot left, shift work to it before the reset.
- If the cross-review provider has no capacity, hold the review until it does. Do not merge unreviewed work.
- Size each task to fit the 5-hour limit the provider has left, with room to spare, so the agent that starts a task finishes it. Split work that would not fit. Never hand a provider a task it is likely to stop partway through.
- Note the provider's 5-hour usage before and after each task in `~/.claude/dispatch-usage.tsv`, and use those numbers to size later tasks. Until enough tasks have been measured, assume about 5% for a one- or two-file change with focused tests and about 15% for a cross-component change. These starting numbers are guesses.
- Keep 10% of Claude's 5-hour and weekly limits free for coordinating, status reports, and reviews of finished work. Start Claude subagents only from the usage above that 10%. When 5% or less is left, only report and queue tasks.

### Temporary Codex-heavy routing (October 29 to November 2, 2026)

Added October 29, 2026. Codex currently gets a free weekly reset about every two days, so unused Codex weekly capacity is lost. From October 29 through November 2, 2026, these rules override the cross-provider rules above. From November 3, 2026, ignore this subsection and delete it at the next policy edit.

- Frontend implementation (UI, components, styling) also goes to Codex: `gpt-6.1-terra` for small changes and `gpt-6.1-sol` for changes across components. The Claude coordinator still runs browser E2E and demo testing itself, because Codex child sessions have no browser.
- Per-task reviews and re-reviews go to a fresh Codex `gpt-6.1-sol` session at `medium` that did not write the code. Opus keeps only the one final whole-branch review before merge, at `xhigh`.
- Ignore the Codex weekly even-pace rule. Move a task from Codex to Claude only when Codex's 5-hour window is at least 85% used or its weekly window is at least 90% used.
- Start a Claude subagent only when the task needs the answer inside this turn's context or Codex is over the limits above.

## Rules for both

Never use max for any role. Other roles use the table defaults, subject to the cross-provider routing overrides above; no default high or xhigh except the final Claude review specified there. Otherwise use high only when a difficult problem survives two attempted fixes. Inherited settings follow these limits.

Use the assigned model and thinking level or effort explicitly when dispatching an allocated role. Recommendations do not change an allocation until the user adopts them. When allocations change, update this file before dispatching future agents. Keep exceptions out of plans.

Dispatch agents with compact task briefs, named files, and acceptance checks. Pass only relevant context instead of the full conversation history.

Keep concurrent writers on separate files. Prefer independent subagents for reviews and testing. The coordinator owns scope, integration, acceptance evidence, and checkpoint delivery.

Plans, task briefs, and ledgers must link to this policy rather than repeat its allocation tables. Historical execution reports may retain the actual model and thinking level or effort used, clearly identified as historical evidence rather than instructions for future dispatches.

These assignments govern development agents. The app's DataReviewer model, provider, prompts, and reasoning settings remain in the server runtime configuration. User-wide Codex defaults remain in the user's Codex configuration, and user-wide Claude Code defaults remain in the user's Claude Code settings.
