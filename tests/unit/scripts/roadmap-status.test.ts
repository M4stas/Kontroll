import { describe, expect, it } from "vitest";
import { checkRow, loadPrs, parseRoadmap, parseWorkLog, type Pr } from "../../../scripts/roadmap-status";

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

  it("checks every PR in a merged claim, including a trailing fix", () => {
    const row = parseRoadmap("| 11 | Check | Result | Merged in #57 with S4 A merged in #58 and its fix in #59 | Plan |")[0]!;
    const prs = new Map([[57, pr(57, "MERGED")], [58, pr(58, "MERGED")], [59, pr(59, "OPEN")]]);
    expect(checkRow(row, prs, new Map())).toEqual(["#57 merged", "#58 merged", "#59 is open, not merged"]);
  });

  it("does not mistake a longer PR number for another reference", () => {
    const row = parseRoadmap("| 11 | Check | Result | Merged in #590 | Plan |")[0]!;
    expect(checkRow(row, new Map([[59, pr(59, "OPEN")], [590, pr(590, "MERGED")]]), new Map())).toEqual(["#590 merged"]);
  });

  it("resolves old PR numbers and branches with targeted queries", () => {
    const calls: string[][] = [];
    const rows = parseRoadmap(roadmap);
    const { prs, prsByBranch } = loadPrs([...rows, ...rows], (args) => {
      calls.push(args);
      if (args[1] === "view") return JSON.stringify(pr(Number(args[2]), "MERGED"));
      if (args.includes("codex/findings")) return JSON.stringify([pr(1, "OPEN", "codex/findings")]);
      throw new Error("unexpected lookup");
    });
    expect(calls).toEqual([
      ["pr", "view", "57", "--json", "number,state,headRefName,title"],
      ["pr", "view", "58", "--json", "number,state,headRefName,title"],
      ["pr", "list", "--state", "all", "--head", "codex/findings", "--limit", "1", "--json", "number,state,headRefName,title"],
    ]);
    expect(prs.get(57)?.state).toBe("MERGED");
    expect(checkRow(rowAt(1), prs, prsByBranch)).toEqual(["STALE: `codex/findings` has PR #1 (open)"]);
  });

  it("flags a branch the roadmap calls unpushed once it has a PR", () => {
    const row = rowAt(1);
    const opened = pr(74, "OPEN", "codex/findings");
    expect(checkRow(row, new Map(), new Map([["codex/findings", opened]]))).toEqual([
      "STALE: `codex/findings` has PR #74 (open)",
    ]);
  });

  it("reads work log entries that name their PR by branch", () => {
    const log = `
| Checkpoint | Completed work | PR | Evidence |
| --- | --- | --- | --- |
| 11, S4 B | Start one check | #57, [#91](https://github.com/o/r/pull/91) | [Plan](plans/a.md) |
| 12, S4 C | Use the PDF | \`codex/findings\` | [Plan](plans/a.md) |
`;
    const rows = parseWorkLog(log);
    expect(rows.map((row) => [row.checkpoint, row.branches])).toEqual([["12, S4 C", ["codex/findings"]]]);
    const merged = pr(94, "MERGED", "codex/findings");
    expect(checkRow(rows[0]!, new Map(), new Map([["codex/findings", merged]]))).toEqual(["`codex/findings` → #94 merged"]);
  });
});
