import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { realpathSync } from "node:fs";

export function normalizeRemote(remote: string): string {
  let value = remote.trim();
  if (/^[^/@:]+@[^/:]+:/.test(value))
    value = value.replace(/^[^@]+@([^:]+):/, "ssh://$1/");
  try {
    const url = new URL(value);
    if (["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
    }
  } catch {
    /* Local remotes are handled by the repository path identity. */
  }
  return "";
}

export function repository(directory = process.cwd()) {
  const cwd = realpathSync(directory);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const root = realpathSync(git("rev-parse", "--show-toplevel"));
    const commonDir = realpathSync(
      resolve(cwd, git("rev-parse", "--git-common-dir")),
    );
    let remote = "";
    try {
      remote = normalizeRemote(git("remote", "get-url", "origin"));
    } catch {
      /* Repositories without remotes are supported. */
    }
    return {
      name: basename(root),
      root,
      commonDir,
      identity: remote ? `remote:${remote}` : `path:${commonDir}`,
      remote,
    };
  } catch {
    throw new Error(
      `Not a Git working tree: ${cwd}. Use --project for an already registered project.`,
    );
  }
}
