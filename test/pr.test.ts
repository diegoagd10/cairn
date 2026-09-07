import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "cairn-pr-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const remote = join(directory, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(repo);
  git("init", "-b", "feature");
  git("config", "user.name", "PR test");
  git("config", "user.email", "pr@example.test");
  git("config", "commit.gpgsign", "false");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  copyFileSync(new URL("../scripts/pr.mjs", import.meta.url), join(repo, "pr.mjs"));
  git("add", ".");
  git("commit", "-m", "fixture");
  const runner = join(directory, "pnpm.cjs");
  const calls = join(directory, "calls");
  writeFileSync(runner, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const name = process.argv[3];
    fs.appendFileSync(process.env.PR_TEST_CALLS, name + '\\n');
    if (process.env.PR_TEST_MUTATION === 'dirty') fs.writeFileSync('dirty.txt', 'changed');
    if (process.env.PR_TEST_MUTATION === 'commit') cp.execFileSync('git', ['commit', '--allow-empty', '-m', 'changed']);
    if (process.env.PR_TEST_MUTATION === 'branch') cp.execFileSync('git', ['switch', '-c', 'other']);
    if (process.env.PR_TEST_MUTATION === 'origin') cp.execFileSync('git', ['remote', 'set-url', 'origin', 'changed']);
    if (process.env.PR_TEST_FAIL === name) process.exit(1);
    if (process.env.PR_TEST_SIGNAL) process.kill(process.pid, 'SIGTERM');
  `);
  const env = { ...process.env, npm_execpath: runner, PR_TEST_CALLS: calls };
  const run = (command = "check", args: string[] = [], extra: Record<string, string> = {}, cwd = repo) =>
    spawnSync(process.execPath, [join(repo, "pr.mjs"), command, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  const summaryPath = () => join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "cairn", "pr-checks", `${git("rev-parse", "HEAD")}.json`);
  const summary = () => JSON.parse(readFileSync(summaryPath(), "utf8"));
  return { directory, repo, git, run, summary, summaryPath, calls };
}

test("PR check records both results against the exact clean branch and commit", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const summary = f.summary();
  assert.equal(summary.status, "passed");
  assert.equal(summary.branch, "feature");
  assert.equal(summary.commit, f.git("rev-parse", "HEAD"));
  assert.deepEqual(summary.checks.map((check: { name: string; exitCode: number }) => [check.name, check.exitCode]), [["verify:deep", 0], ["test:deployment", 0]]);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.ok(summary.startedAt && summary.finishedAt);
});

test("dirty, detached, and default branches are blocked before executing checks", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "untracked"), "change");
  assert.match(f.run().stderr, /tracked and untracked/);
  f.git("add", "untracked");
  assert.notEqual(f.run().status, 0);
  f.git("reset", "--hard");
  f.git("switch", "--detach");
  assert.notEqual(f.run().status, 0);
  f.git("switch", "-c", "main");
  assert.match(f.run().stderr, /PR branch/);
  f.git("switch", "-c", "trunk");
  f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  f.git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  assert.match(f.run().stderr, /PR branch/);
  assert.equal(existsSync(f.calls), false);
});

test("failed and interrupted reruns invalidate a previous passing summary", t => {
  const f = fixture(t);
  for (const name of ["verify:deep", "test:deployment"]) {
    assert.equal(f.run().status, 0);
    assert.notEqual(f.run("check", [], { PR_TEST_FAIL: name }).status, 0);
    assert.equal(f.summary().status, "failed");
    assert.match(f.run("create").stderr, /not passed/);
  }
  assert.equal(f.run().status, 0);
  assert.notEqual(f.run("check", [], { PR_TEST_SIGNAL: "1" }).status, 0);
  assert.equal(f.summary().status, "failed");
});

for (const mutation of ["dirty", "commit", "branch", "origin"]) {
  test(`a ${mutation} change during checks blocks approval`, t => {
    const f = fixture(t);
    const path = f.summaryPath();
    assert.notEqual(f.run("check", [], { PR_TEST_MUTATION: mutation }).status, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "failed");
    assert.notEqual(f.run("create").status, 0);
  });
}

test("PR creation rejects absent, corrupt, incomplete, and stale summaries and unpublished heads", t => {
  const f = fixture(t);
  assert.match(f.run("create").stderr, /No valid summary/);
  assert.equal(f.run().status, 0);
  assert.match(f.run("create").stderr, /Push it/);
  const path = f.summaryPath();
  const valid = readFileSync(path, "utf8");
  for (const data of ["invalid", "null", JSON.stringify({ ...JSON.parse(valid), checks: [] }), JSON.stringify({ ...JSON.parse(valid), status: "running" })]) {
    writeFileSync(path, data);
    assert.notEqual(f.run("create").status, 0);
  }
  writeFileSync(path, valid);
  f.git("switch", "-c", "renamed");
  assert.match(f.run("create").stderr, /not passed/);
  f.git("switch", "feature");
  f.git("commit", "--allow-empty", "-m", "new commit");
  assert.match(f.run("create").stderr, /No valid summary/);
});

test("worktrees share the summary directory while approvals remain branch-specific", t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const worktree = join(f.directory, "worktree");
  f.git("worktree", "add", "-b", "worktree", worktree);
  assert.match(f.run("create", [], {}, worktree).stderr, /not passed/);
  assert.equal(f.run("check", [], {}, worktree).status, 0);
  assert.equal(f.summary().branch, "worktree");
  assert.match(f.run("create").stderr, /not passed/);
});

test("PR creation invokes gh only for the checked remote head and rejects target overrides", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const bin = join(f.directory, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  const invoked = join(f.directory, "gh-args");
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PR_TEST_GH_ARGS"\nexit "${PR_TEST_GH_EXIT:-0}"\n');
  chmodSync(gh, 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, PR_TEST_GH_ARGS: invoked };
  assert.equal(f.run().status, 0);
  f.git("push", "origin", "HEAD");
  for (const args of [["--head", "other"], ["--repo=other/repo"], ["-R", "other/repo"], ["--web"], ["--title"]]) {
    assert.notEqual(f.run("create", args, env).status, 0);
    assert.equal(existsSync(invoked), false);
  }
  const result = f.run("create", ["--fill", "--draft"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(invoked, "utf8").trim().split("\n"), ["pr", "create", "--repo", f.git("remote", "get-url", "--push", "origin"), "--head", "feature", "--fill", "--draft"]);
  assert.notEqual(f.run("create", ["--fill"], { ...env, PR_TEST_GH_EXIT: "1" }).status, 0);
  f.git("commit", "--allow-empty", "-m", "advance");
  assert.equal(f.run().status, 0);
  rmSync(invoked);
  assert.match(f.run("create", ["--fill"], env).stderr, /Push it/);
  assert.equal(existsSync(invoked), false);
});
