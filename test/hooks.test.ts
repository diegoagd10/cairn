import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "cairn-hooks-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  const remote = join(directory, "remote.git");
  mkdirSync(repo);
  const env = { ...process.env, HOOK_TEST_LOG: join(directory, "checks.log") };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const attempt = (args: string[], extra: Record<string, string> = {}) => spawnSync("git", args, {
    cwd: repo, env: { ...env, ...extra }, encoding: "utf8",
  });
  git("init", "-b", "feature");
  git("config", "user.name", "Hook test");
  git("config", "user.email", "hooks@example.test");
  git("config", "commit.gpgsign", "false");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, ".githooks"));
  for (const file of ["scripts/git-hooks.mjs", "scripts/install-hooks.mjs", "scripts/pr.mjs", ".githooks/pre-commit", ".githooks/pre-push"]) {
    copyFileSync(new URL(`../${file}`, import.meta.url), join(repo, file));
  }
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    private: true, packageManager: "pnpm@11.3.0", scripts: {
      "hook:commit": "node scripts/git-hooks.mjs commit",
      "hook:push": "node scripts/git-hooks.mjs push",
      "pr:check": "node scripts/pr.mjs check",
      "verify:deep": "node gate.cjs verify:deep",
      "test:deployment": "node gate.cjs test:deployment",
    },
  }));
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "gate.cjs"), `
    const fs = require('node:fs');
    const name = process.argv[2];
    fs.appendFileSync(process.env.HOOK_TEST_LOG, name + '\\n');
    console.log('CHECK OUTPUT: ' + name);
    if (fs.readFileSync('a.txt', 'utf8').includes('broken') || process.env.HOOK_TEST_FAIL === name) {
      console.error('FIX REQUIRED: ' + name);
      process.exit(1);
    }
  `);
  writeFileSync(join(repo, "a.txt"), "good\n");
  writeFileSync(join(repo, "b.txt"), "original\n");
  // Establish fixtures before installing the hooks under test.
  git("add", ".");
  git("commit", "-m", "fixture");
  const install = () => spawnSync(process.execPath, [join(repo, "scripts/install-hooks.mjs")], { cwd: repo, env, encoding: "utf8" });
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  // Account for executable mode changes made by the installer on POSIX.
  git("add", ".githooks");
  const baseline = attempt(["commit", "--allow-empty", "-m", "enable hooks"]);
  assert.equal(baseline.status, 0, baseline.stderr + baseline.stdout);
  rmSync(env.HOOK_TEST_LOG, { force: true });
  return { directory, repo, remote, git, attempt, install, env };
}

test("pre-commit rejects broken staged content even when unstaged content fixes it", t => {
  const f = fixture(t);
  const before = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.repo, "a.txt"), "broken\n");
  f.git("add", "a.txt");
  writeFileSync(join(f.repo, "a.txt"), "good unstaged fix\n");
  const result = f.attempt(["commit", "-m", "must fail"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /FIX REQUIRED: verify:deep/);
  assert.match(result.stderr + result.stdout, /Git operation blocked/);
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(f.git("show", ":a.txt"), "broken");
  assert.equal(readFileSync(join(f.repo, "a.txt"), "utf8"), "good unstaged fix\n");
});

test("pre-commit checks staged content without altering unstaged or untracked files", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "a.txt"), "good staged\n");
  f.git("add", "a.txt");
  writeFileSync(join(f.repo, "a.txt"), "broken unstaged\n");
  writeFileSync(join(f.repo, "notes.txt"), "keep me\n");
  const result = f.attempt(["commit", "-m", "staged only"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.git("show", "HEAD:a.txt"), "good staged");
  assert.equal(readFileSync(join(f.repo, "a.txt"), "utf8"), "broken unstaged\n");
  assert.equal(readFileSync(join(f.repo, "notes.txt"), "utf8"), "keep me\n");
  assert.equal(readFileSync(f.env.HOOK_TEST_LOG, "utf8"), "verify:deep\ntest:deployment\n");
});

test("pre-commit honors the temporary index used by git commit --only", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "a.txt"), "broken staged for later\n");
  f.git("add", "a.txt");
  writeFileSync(join(f.repo, "b.txt"), "commit this\n");
  const result = f.attempt(["commit", "--only", "b.txt", "-m", "only b"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.git("show", "HEAD:a.txt"), "good");
  assert.equal(f.git("show", ":a.txt"), "broken staged for later");
  assert.equal(f.git("show", "HEAD:b.txt"), "commit this");
});

test("deployment failures reject commits and pushes, revoke PR approval, and show actionable output", t => {
  const f = fixture(t);
  const head = f.git("rev-parse", "HEAD");
  const failure = { HOOK_TEST_FAIL: "test:deployment" };
  const commit = f.attempt(["commit", "--allow-empty", "-m", "must fail"], failure);
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr + commit.stdout, /FIX REQUIRED: test:deployment/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  const push = f.attempt(["push", "origin", "HEAD"]);
  assert.equal(push.status, 0, push.stderr + push.stdout);
  assert.equal(f.git("ls-remote", "origin", "refs/heads/feature"), `${head}\trefs/heads/feature`);
  f.git("commit", "--allow-empty", "-m", "next");
  const failedPush = f.attempt(["push", "origin", "HEAD"], failure);
  assert.notEqual(failedPush.status, 0);
  assert.match(failedPush.stderr + failedPush.stdout, /FIX REQUIRED: test:deployment/);
  assert.equal(f.git("ls-remote", "origin", "refs/heads/feature"), `${head}\trefs/heads/feature`);
  const summaryPath = join(f.repo, ".git", "cairn", "pr-checks", `${f.git("rev-parse", "HEAD")}.json`);
  assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).status, "failed");
  const retry = f.attempt(["push", "origin", "HEAD"]);
  assert.equal(retry.status, 0, retry.stderr + retry.stdout);
  assert.equal(JSON.parse(readFileSync(summaryPath, "utf8")).status, "passed");
});

test("pre-push blocks other refs, tags, and dirty checkouts before publication", t => {
  const f = fixture(t);
  f.git("branch", "other");
  f.git("tag", "v-test");
  for (const ref of ["other", "v-test", "HEAD:renamed"]) {
    const result = f.attempt(["push", "origin", ref]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Push the current branch/);
  }
  writeFileSync(join(f.repo, "untracked"), "dirty");
  const result = f.attempt(["push", "origin", "HEAD"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /tracked and untracked/);
  assert.equal(f.git("ls-remote", "--heads", "origin"), "");
  assert.equal(existsSync(f.env.HOOK_TEST_LOG), false);
});

test("hook installation is idempotent and preserves existing hook configurations", t => {
  const f = fixture(t);
  assert.equal(f.install().status, 0);
  f.git("config", "core.hooksPath", "custom-hooks");
  assert.notEqual(f.install().status, 0);
  assert.equal(f.git("config", "core.hooksPath"), "custom-hooks");
});
