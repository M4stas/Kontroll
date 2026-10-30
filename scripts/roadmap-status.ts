// Print each roadmap checkpoint beside the live state of the PRs and branches
// its Status cell names, and flag rows whose text no longer matches GitHub.
// Usage: pnpm roadmap:status
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Pr = { number: number; state: "OPEN" | "CLOSED" | "MERGED"; headRefName: string; title: string };
export type Row = { checkpoint: string; name: string; status: string; prs: number[]; branches: string[] };

export function parseRoadmap(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split("\n")) {
    const [, checkpoint = "", name = "", , status = "", source] = line.split("|").map((cell) => cell.trim());
    // A checkpoint row: | 12 | Name | What you will see | Status | Source |
    if (source === undefined || !/^\d+$/.test(checkpoint)) continue;
    rows.push({
      checkpoint,
      name,
      status,
      prs: [...status.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
      branches: [...status.matchAll(/`([\w./-]+)`/g)].flatMap((m) => (m[1] && m[1] !== "main" ? [m[1]] : [])),
    });
  }
  return rows;
}

export function checkRow(
  row: Row,
  prs: Map<number, Pr>,
  prsByBranch: Map<string, Pr>,
  commitsAhead: (branch: string) => number | null = () => null,
): string[] {
  const notes: string[] = [];
  const says = row.status.toLowerCase();
  for (const number of row.prs) {
    const pr = prs.get(number);
    if (!pr) notes.push(`#${number} not found`);
    else if (pr.state !== "MERGED" && /\bmerged\b/.test(says)) notes.push(`#${number} is ${pr.state.toLowerCase()}, not merged`);
    else notes.push(`#${number} ${pr.state.toLowerCase()}`);
  }
  for (const branch of row.branches) {
    const pr = prsByBranch.get(branch);
    if (pr && /no pr|not pushed/.test(says)) notes.push(`STALE: \`${branch}\` has PR #${pr.number} (${pr.state.toLowerCase()})`);
    else if (pr) notes.push(`\`${branch}\` → #${pr.number} ${pr.state.toLowerCase()}`);
    else {
      const ahead = commitsAhead(branch);
      notes.push(ahead === null ? `\`${branch}\` not found locally, no PR` : `\`${branch}\` ${ahead} commits ahead of origin/main, no PR`);
    }
  }
  return notes;
}

export function loadPrs(
  rows: Row[],
  run: (args: string[]) => string = (args) => execFileSync("gh", args, { encoding: "utf8" }),
): { prs: Map<number, Pr>; prsByBranch: Map<string, Pr> } {
  const fields = "number,state,headRefName,title";
  const prs = new Map<number, Pr>();
  for (const number of new Set(rows.flatMap((row) => row.prs))) {
    const pr: Pr = JSON.parse(run(["pr", "view", String(number), "--json", fields]));
    prs.set(number, pr);
  }
  const prsByBranch = new Map<string, Pr>();
  for (const branch of new Set(rows.flatMap((row) => row.branches))) {
    const list: Pr[] = JSON.parse(run(["pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", fields]));
    if (list[0]) prsByBranch.set(branch, list[0]);
  }
  return { prs, prsByBranch };
}

function main() {
  const rows = parseRoadmap(readFileSync("docs/superpowers/roadmap.md", "utf8"));
  const { prs, prsByBranch } = loadPrs(rows);
  const commitsAhead = (branch: string) => {
    try {
      return Number(execFileSync("git", ["rev-list", "--count", `origin/main..${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return null;
    }
  };
  for (const row of rows) {
    const notes = checkRow(row, prs, prsByBranch, commitsAhead);
    console.log(`${row.checkpoint}. ${row.name}\n   roadmap: ${row.status}`);
    if (notes.length) console.log(`   github:  ${notes.join("; ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
