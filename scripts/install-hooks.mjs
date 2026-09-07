import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

try {
  const location = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (location.status !== 0 || realpathSync(location.stdout.trim()) !== realpathSync(root)) {
    if (!process.argv.includes("--if-repository")) throw new Error("Install hooks from a Cairn Git checkout.");
  } else {
    const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    if (configured.status !== 0 && configured.status !== 1) throw new Error("Cannot read core.hooksPath.");
    const existing = configured.stdout.trim();
    if (existing && existing !== ".githooks") throw new Error(`Existing core.hooksPath (${existing}) must be integrated before installing Cairn hooks.`);
    if (!existing) {
      const hooks = git("rev-parse", "--path-format=absolute", "--git-path", "hooks");
      const active = existsSync(hooks) ? readdirSync(hooks).filter(name => !name.endsWith(".sample")) : [];
      if (active.length) throw new Error(`Existing hooks in ${hooks} must be integrated first: ${active.join(", ")}`);
    }
    for (const name of ["pre-commit", "pre-push"]) chmodSync(resolve(root, ".githooks", name), 0o755);
    git("config", "--local", "core.hooksPath", ".githooks");
    console.log("Cairn pre-commit and pre-push hooks enabled (.githooks).");
  }
} catch (error) {
  console.error(`Hook installation failed: ${error.message}`);
  process.exitCode = 1;
}
