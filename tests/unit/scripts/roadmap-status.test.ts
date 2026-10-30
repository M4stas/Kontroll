import { describe, expect, it } from "vitest";
import { checkRow, parseRoadmap, type Pr } from "../../../scripts/roadmap-status";

const roadmap = `
| # | Checkpoint | What you will see | Status | Source |
| --- | --- | --- | --- | --- |
| 11 | Background check | A line pulses | Merged in #57, with S4 A merged in #58 | [Plan](plans/a.md) |
| 12 | Findings | Uses the PDF | In progress on the local branch \`codex/findings\`; not pushed and no PR | [Plan](plans/a.md) |
| 13 | Source | Names Auto24 | Not planned | [Spec](specs/b.md) |
`;

function rowAt(index: number) {
  const row = parseRoadmap(roadmap)[index];
  if (!row) throw new Error(`no roadmap row ${index}`);
  return row;
}

const pr = (number: number, state: Pr["state"], headRefName = `b${number}`): Pr => ({ number, state, headRefName, title: "" });

describe("roadmap status", () => {
  it("reads checkpoint rows with their PR numbers and branches", () => {
    expect(parseRoadmap(roadmap).map((row) => row.checkpoint)).toEqual(["11", "12", "13"]);
    expect(rowAt(0).prs).toEqual([57, 58]);
    expect(rowAt(1).branches).toEqual(["codex/findings"]);
  });

  it("flags a row that says merged when the PR is still open", () => {
    const row = rowAt(0);
    const prs = new Map([[57, pr(57, "OPEN")], [58, pr(58, "MERGED")]]);
    expect(checkRow(row, prs, new Map())).toEqual(["#57 is open, not merged", "#58 merged"]);
  });

  it("flags a branch the roadmap calls unpushed once it has a PR", () => {
    const row = rowAt(1);
    const opened = pr(74, "OPEN", "codex/findings");
    expect(checkRow(row, new Map(), new Map([["codex/findings", opened]]))).toEqual([
      "STALE: `codex/findings` has PR #74 (open)",
    ]);
  });
});
