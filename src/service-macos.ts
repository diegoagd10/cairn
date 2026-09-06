import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checked, installArguments, managedFile, nativeRuntime } from "./service-common.ts";
import type { ServiceRuntime } from "./service-common.ts";

const label = "local.cairn.viewer";
const marker = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by cairn service install -->\n';
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function macService(action: string, cli: string, db?: string, port?: string, runtime: ServiceRuntime = nativeRuntime) {
  const path = join(runtime.home, "Library/LaunchAgents", `${label}.plist`);
  const logs = join(runtime.home, "Library/Logs/Cairn");
  const installed = managedFile(path, marker);
  if (!installed && ["status", "uninstall"].includes(action)) return { installed: false, path };
  if (!installed && action !== "install") throw new Error("Service is not installed. Run cairn service install first.");
  const args = action === "install" ? installArguments(runtime, cli, db, port) : undefined;
  if (runtime.uid === undefined) throw new Error("Cannot determine the current macOS user ID.");
  const domain = `gui/${runtime.uid}`;
  const target = `${domain}/${label}`;
  const launchctl = (...args: string[]) => checked(runtime, "launchctl", args);
  // A missing GUI session must not be mistaken for an unloaded job.
  launchctl("print", domain);
  const inspect = () => {
    const result = runtime.run("launchctl", ["print", target]);
    if (!result.error && result.status === 0) return result.stdout;
    if (!result.error && /Could not find service/.test(result.stderr)) return undefined;
    throw new Error(`Cannot inspect launchd service: ${result.error?.message || result.stderr || result.status}`);
  };
  const loaded = inspect();
  if (!installed && loaded !== undefined)
    throw new Error(`Refusing to replace an existing launchd job: ${label}`);

  if (action === "install") {
    if (loaded !== undefined) launchctl("bootout", target);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${marker}<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args!.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(logs, "viewer.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "viewer.error.log"))}</string>
</dict>
</plist>
`, { mode: 0o600 });
    launchctl("enable", target);
    launchctl("bootstrap", domain, path);
  } else if (action === "start") {
    launchctl("enable", target);
    if (loaded === undefined) launchctl("bootstrap", domain, path);
    else if (!/^\s*state = running\s*$/m.test(loaded)) launchctl("kickstart", target);
  } else if (action === "stop" || action === "uninstall") {
    launchctl("disable", target);
    if (loaded !== undefined) launchctl("bootout", target);
    if (action === "uninstall") {
      unlinkSync(path);
      return { installed: false, path };
    }
  }
  const current = inspect();
  const disabled = launchctl("print-disabled", domain);
  const state = current?.match(/^\s*state = (.+)$/m)?.[1]?.trim() ?? "unloaded";
  return {
    installed: true, path, logs,
    active: state === "running" ? "active" : "inactive",
    state,
    startup: /"local\.cairn\.viewer"\s*=>\s*true/.test(disabled) ? "disabled" : "enabled",
  };
}
