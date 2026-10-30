// Print each roadmap checkpoint beside the live state of the PRs and branches
// its Status cell names, and flag rows whose text no longer matches GitHub.
// Usage: pnpm roadmap:status [path/to/roadmap.md]
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
    else if (pr.state !== "MERGED" && says.includes(`merged in #${number}`)) notes.push(`#${number} is ${pr.state.toLowerCase()}, not merged`);
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

function main() {
  const path = process.argv[2] ?? "docs/superpowers/roadmap.md";
  const rows = parseRoadmap(readFileSync(path, "utf8"));
  const list: Pr[] = JSON.parse(
    execFileSync("gh", ["pr", "list", "--state", "all", "--limit", "300", "--json", "number,state,headRefName,title"], {
      encoding: "utf8",
    }),
  );
  const prs = new Map(list.map((pr) => [pr.number, pr]));
  // gh lists newest first, so the first PR per branch is the latest one.
  const prsByBranch = new Map<string, Pr>();
  for (const pr of list) if (!prsByBranch.has(pr.headRefName)) prsByBranch.set(pr.headRefName, pr);
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
