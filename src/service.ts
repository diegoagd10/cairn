import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultDatabase } from "./store.ts";
import { macService } from "./service-macos.ts";
import { windowsService } from "./service-windows.ts";

const unit = "cairn.service";
const marker = "# Managed by cairn service install\n";
export const serviceActions = ["install", "start", "stop", "status", "uninstall"] as const;

// systemd has its own quoting rules, including % specifiers. ExecStart's ':'
// prefix disables environment expansion so paths containing '$' remain literal.
function quote(value: string) {
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Service paths must not contain control characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function systemctl(...args: string[]) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "cat" },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${result.error?.message || result.stderr.trim() || result.stdout.trim() || result.status}. ` +
      "Run this from your Linux user session with systemd available. " +
      "Inspect logs with journalctl --user -u cairn.service -n 50 --no-pager.",
    );
  return result.stdout;
}

export function service(action: string, cliPath: string, db?: string, port?: string) {
  if (!serviceActions.includes(action as typeof serviceActions[number]))
    throw new Error(`Expected service ${serviceActions.join(", ")}.`);
  if (process.platform === "darwin") return macService(action, cliPath, db, port);
  if (process.platform === "win32") return windowsService(action, cliPath, db, port);
  if (process.platform !== "linux")
    throw new Error("Cairn services support Linux with systemd, macOS, and Windows. Use cairn serve on this platform.");
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(config)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  const path = join(config, "systemd", "user", unit);
  let installed = false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || !readFileSync(path, "utf8").startsWith(marker))
      throw new Error(`Refusing to manage a service not created by Cairn: ${path}`);
    installed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (action === "install") {
    const number = Number(port ?? 4317);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error("Port must be between 1 and 65535.");
    const database = db ?? defaultDatabase();
    if (database === ":memory:") throw new Error("A persistent service requires a database file.");
    const exec = [process.execPath, resolve(cliPath), "serve", "--db", resolve(database), "--port", String(number)]
      .map(quote).join(" ");
    const content = `${marker}[Unit]
Description=Cairn local read-only viewer

[Service]
Type=exec
ExecStart=:${exec}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
    // Check that the user manager is reachable before writing any configuration.
    systemctl("show-environment");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    systemctl("daemon-reload");
    systemctl("enable", unit);
    systemctl("restart", unit);
  } else if (action === "status") {
    if (!installed) return { installed: false, path };
  } else if (action === "uninstall") {
    if (!installed) return { installed: false, path };
    systemctl("disable", "--now", unit);
    unlinkSync(path);
    systemctl("daemon-reload");
    return { installed: false, path };
  } else if (action === "start" || action === "stop") {
    if (!installed) throw new Error("Service is not installed. Run cairn service install first.");
    systemctl(action === "start" ? "enable" : "disable", "--now", unit);
  } else {
    throw new Error(`Expected service ${serviceActions.join(", ")}.`);
  }
  const properties = systemctl("show", unit, "--property=ActiveState,SubState,UnitFileState");
  const state = Object.fromEntries(properties.trim().split("\n").map((line) => line.split("=")));
  return { installed: true, path, active: state.ActiveState, state: state.SubState, startup: state.UnitFileState };
}
