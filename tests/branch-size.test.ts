import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const source = resolve("scripts/check-branch-size.sh");
const hook = resolve(".githooks/pre-push");
const repos: string[] = [];

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(files: number, lines: number, lockLines = 0) {
  const repo = mkdtempSync(join(tmpdir(), "branch-size-"));
  repos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "commit", "--allow-empty", "-qm", "base");
  git(repo, "branch", "base");
  for (let i = 0; i < files; i++) {
    writeFileSync(join(repo, `file-${i}.txt`), "line\n".repeat(i === 0 ? lines - files + 1 : 1));
  }
  if (lockLines) writeFileSync(join(repo, "pnpm-lock.yaml"), "line\n".repeat(lockLines));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "changes");
  return repo;
}

function run(repo: string, executable: string, arg: string) {
  return spawnSync(executable, [arg], { cwd: repo, encoding: "utf8", input: "ignored input\n" });
}

afterEach(() => { for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true }); });

test("does not warn at 15 files and 500 lines", () => {
  const result = run(repository(15, 500), source, "base");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("warns at 16 files", () => {
  const result = run(repository(16, 16), source, "base");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/16.*15/);
});

test("warns at 501 changed lines", () => {
  const result = run(repository(1, 501), source, "base");
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/501.*500/);
});

test("excludes the lockfile from both counts", () => {
  const result = run(repository(15, 500, 600), source, "base");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("silently succeeds when the base is missing", () => {
  const result = run(repository(1, 1), source, "missing-base");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});

test("the pre-push hook warns only for the no-mistakes remote", () => {
  const repo = repository(16, 16);
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "base"));
  mkdirSync(join(repo, "scripts"));
  copyFileSync(source, join(repo, "scripts/check-branch-size.sh"));
  chmodSync(join(repo, "scripts/check-branch-size.sh"), 0o755);
  const review = run(repo, hook, "no-mistakes");
  const origin = run(repo, hook, "origin");
  expect(review.status).toBe(0);
  expect(review.stderr).toMatch(/16.*15/);
  expect(origin.status).toBe(0);
  expect(origin.stdout).toBe("");
  expect(origin.stderr).toBe("");
});
