import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function run(args, cwd, env) {
  if (!process.env.npm_execpath) throw new Error("Run hooks through pnpm.");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.signal || result.status}). Fix the errors above and retry; do not bypass the hook.`);
}

function commit(env) {
  // Git may supply a temporary index for `git commit --only`. Export that index,
  // never the working tree, so unstaged fixes cannot hide a broken staged file.
  const tree = git("write-tree");
  const directory = mkdtempSync(join(tmpdir(), "cairn-pre-commit-"));
  console.log(`Checking staged tree ${tree} before commit.`);
  try {
    git("checkout-index", "--all", "--ignore-skip-worktree-bits", `--prefix=${directory}${sep}`);
    execFileSync("git", ["init", "-b", "hook-check", directory], { env, stdio: "ignore" });
    // No lifecycle hooks: this isolated installation must not install Git hooks.
    run(["install", "--frozen-lockfile", "--ignore-scripts"], directory, env);
    run(["run", "verify:deep"], directory, env);
    run(["run", "test:deployment"], directory, env);
    if (git("write-tree") !== tree) throw new Error("The staged content changed during checks. Review it and retry the commit.");
    console.log(`Staged tree ${tree} passed. Git may create the commit.`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function push(root, env, args) {
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/));
  if (updates.some(parts => parts.length !== 4)) throw new Error("Invalid pre-push ref input.");
  const publishing = updates.filter(([, sha]) => !/^0+$/.test(sha));
  if (!publishing.length) return; // Deletions do not publish code.
  const branch = git("branch", "--show-current");
  const head = git("rev-parse", "HEAD");
  const remote = git("remote", "get-url", "--push", "origin");
  if (args[0] !== "origin" || args[1] !== remote || publishing.length !== 1 ||
      publishing[0][1] !== head || publishing[0][2] !== `refs/heads/${branch}`) {
    throw new Error("Push the current branch to origin with git push -u origin HEAD. Other branches, tags, and renamed destinations must be pushed separately through a checked branch.");
  }
  run(["run", "pr:check"], root, env);
  if (git("rev-parse", "HEAD") !== head || git("branch", "--show-current") !== branch) {
    throw new Error("The branch or commit changed during pre-push. Retry the push.");
  }
}

try {
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);
  // Git exports repository-local variables to hooks. Child checks create their
  // own repositories; inheriting GIT_INDEX_FILE/GIT_DIR would corrupt isolation.
  const env = { ...process.env };
  for (const name of git("rev-parse", "--local-env-vars").split("\n")) delete env[name];
  const [command, ...args] = process.argv.slice(2);
  if (command === "commit") commit(env);
  else if (command === "push") push(root, env, args);
  else throw new Error("Expected commit or push hook.");
} catch (error) {
  console.error(`Git operation blocked: ${error.message}`);
  process.exitCode = 1;
}
