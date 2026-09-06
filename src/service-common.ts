import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultDatabase } from "./store.ts";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export const nativeRuntime = {
  home: homedir(),
  node: process.execPath,
  uid: process.getuid?.(),
  run(command: string, args: string[]): CommandResult {
    return spawnSync(command, args, {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
    });
  },
};
export type ServiceRuntime = typeof nativeRuntime;

export function checked(runtime: ServiceRuntime, command: string, args: string[]) {
  const result = runtime.run(command, args);
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || result.status}`);
  return result.stdout;
}

export function managedFile(path: string, marker: string) {
  try {
    if (!lstatSync(path).isFile() || !readFileSync(path, "utf8").startsWith(marker))
      throw new Error(`Refusing to manage a service not created by Cairn: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function installArguments(runtime: ServiceRuntime, cli: string, db?: string, port?: string) {
  const number = Number(port ?? 4317);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    throw new Error("Port must be between 1 and 65535.");
  const database = db ?? defaultDatabase();
  if (database === ":memory:") throw new Error("A persistent service requires a database file.");
  const args = [runtime.node, resolve(cli), "serve", "--db", resolve(database), "--port", String(number)];
  if ([...args, runtime.home].some((value) => /[\x00-\x1f\x7f]/.test(value)))
    throw new Error("Service paths must not contain control characters.");
  return args;
}
