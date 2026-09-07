import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const checks = ["verify:deep", "test:deployment"];
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function snapshot() {
  const branch = git("branch", "--show-current");
  if (!branch) throw new Error("Detached HEAD: switch to a PR branch first.");
  const commit = git("rev-parse", "HEAD");
  let defaultBranch;
  try { defaultBranch = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch {}
  if (["main", "master", defaultBranch].includes(branch)) {
    throw new Error("Switch to a PR branch before checking or creating a PR.");
  }
  if (git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")) {
    throw new Error("Commit or remove all tracked and untracked changes first.");
  }
  const remote = git("remote", "get-url", "--push", "origin");
  return { branch, commit, remote };
}

function assertSame(expected) {
  if (JSON.stringify(snapshot()) !== JSON.stringify(expected)) {
    throw new Error("Branch, commit, or origin changed. Run pnpm pr:check again.");
  }
}

function save(path, summary) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  renameSync(temporary, path);
}

function check(current, path) {
  const summary = {
    version: 1, ...current, node: process.version, platform: process.platform,
    startedAt: new Date().toISOString(), status: "running", checks: [],
  };
  // Invalidate any previous pass before starting; interrupted runs stay blocked.
  save(path, summary);
  console.log(`Checking ${current.branch} at ${current.commit}`);
  try {
    for (const name of checks) {
      const started = Date.now();
      // pnpm supplies its JS entry point, avoiding shell invocation on Windows.
      if (!process.env.npm_execpath) throw new Error("Run this command through pnpm pr:check.");
      const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", name], { stdio: "inherit" });
      summary.checks.push({ name, exitCode: result.status, signal: result.signal, durationMs: Date.now() - started });
      save(path, summary);
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${name} failed; PR creation is blocked.`);
      assertSame(current);
    }
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = error.message;
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    save(path, summary);
    console.log(`PR check summary: ${path}`);
  }
  console.log("Checks passed. Push this commit to origin, then use pnpm pr:create.");
}

function create(current, path, args) {
  // A small allowlist prevents overriding the checked head or repository.
  const values = new Set(["--title", "--body", "--body-file", "--base"]);
  const flags = new Set(["--draft", "--fill", "--fill-first", "--fill-verbose"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) continue;
    if (!values.has(arg) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Unsupported or incomplete PR option: ${arg}`);
    }
    index++;
  }
  let summary;
  try { summary = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("No valid summary for this commit. Run pnpm pr:check first.");
  }
  if (summary?.version !== 1 || summary.status !== "passed" ||
      summary.branch !== current.branch || summary.commit !== current.commit || summary.remote !== current.remote ||
      summary.checks?.length !== checks.length ||
      !checks.every((name, index) => summary.checks[index]?.name === name && summary.checks[index]?.exitCode === 0)) {
    throw new Error("Checks have not passed for this branch and commit. Run pnpm pr:check first.");
  }
  const ref = `refs/heads/${current.branch}`;
  const published = git("ls-remote", "--heads", current.remote, ref);
  if (published !== `${current.commit}\t${ref}`) {
    throw new Error("Origin does not contain the checked commit at this branch. Push it before creating the PR.");
  }
  assertSame(current);
  const result = spawnSync("gh", ["pr", "create", "--repo", current.remote, "--head", current.branch, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh pr create failed (${result.signal || result.status}).`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!["check", "create"].includes(command) || (command === "check" && args.length)) {
    throw new Error("Usage: pnpm pr:check | pnpm pr:create [--title TEXT --body TEXT | --fill] [--base BRANCH] [--draft]");
  }
  // Run checks from the repository root even when invoked from a subdirectory.
  process.chdir(git("rev-parse", "--show-toplevel"));
  const current = snapshot();
  const directory = join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "cairn", "pr-checks");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${current.commit}.json`);
  if (command === "check") check(current, path);
  else create(current, path, args);
} catch (error) {
  console.error(`PR blocked: ${error.message}`);
  process.exitCode = 1;
}
