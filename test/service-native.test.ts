import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macService } from "../src/service-macos.ts";
import { windowsService } from "../src/service-windows.ts";
import type { ServiceRuntime } from "../src/service-common.ts";

function directory(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "cairn-native-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function macFixture(t: { after: (fn: () => void) => void }) {
  const home = directory(t);
  const calls: string[][] = [];
  const state = { loaded: false, disabled: false, fail: "", running: true };
  const runtime: ServiceRuntime = {
    home, node: process.execPath, uid: 501,
    run(command, args) {
      assert.equal(command, "launchctl");
      calls.push(args);
      if (args[0] === state.fail) return { status: 1, stdout: "", stderr: "permission denied" };
      let stdout = "";
      if (args[0] === "print" && args[1] !== "gui/501") {
        if (!state.loaded) return { status: 113, stdout: "", stderr: 'Could not find service "local.cairn.viewer" in domain for user gui: 501' };
        stdout = `gui/501/local.cairn.viewer = {\n state = ${state.running ? "running" : "waiting"}\n}`;
      }
      if (args[0] === "print-disabled") stdout = `disabled services = {\n "local.cairn.viewer" => ${state.disabled}\n}`;
      if (args[0] === "bootstrap") {
        assert.ok(existsSync(args[2]!));
        assert.equal(state.disabled, false);
        state.loaded = true;
      }
      if (args[0] === "bootout") state.loaded = false;
      if (args[0] === "enable") state.disabled = false;
      if (args[0] === "disable") state.disabled = true;
      if (args[0] === "kickstart") state.running = true;
      return { status: 0, stdout, stderr: "" };
    },
  };
  const run = (action: string, db?: string, port?: string) => macService(action, join(home, "cli.js"), db, port, runtime);
  return { home, calls, state, run };
}

test("macOS service persists login startup state, reloads settings, and keeps data", (t) => {
  const { home, state, calls, run } = macFixture(t);
  assert.equal(run("status").installed, false);
  assert.deepEqual(calls, []);
  assert.throws(() => run("start"), /not installed/);
  const database = join(home, "data.sqlite");
  writeFileSync(database, "keep");
  const result = run("install", database, "4318");
  assert.equal(result.active, "active");
  assert.equal(result.startup, "enabled");
  assert.match(readFileSync(result.path, "utf8"), /<string>4318<\/string>/);
  assert.equal(run("stop").startup, "disabled");
  assert.equal(run("status").active, "inactive");
  assert.equal(state.loaded, false);
  assert.equal(run("stop").startup, "disabled", "stopping twice is safe");
  assert.equal(run("start").active, "active");
  state.running = false;
  assert.equal(run("start").active, "active", "start recovers a loaded but idle job");
  run("install", database, "4319");
  assert.match(readFileSync(result.path, "utf8"), /<string>4319<\/string>/);
  assert.equal(run("uninstall").installed, false);
  assert.equal(existsSync(result.path), false);
  assert.equal(state.loaded, false);
  assert.equal(readFileSync(database, "utf8"), "keep");
  assert.equal(run("uninstall").installed, false);
});

test("macOS plist preserves special characters and passes the native parser on macOS", (t) => {
  const { home, run } = macFixture(t);
  const result = run("install", join(home, 'á & < > " $ %.sqlite'));
  const plist = readFileSync(result.path, "utf8");
  assert.match(plist, /á &amp; &lt; &gt; &quot; \$ %\.sqlite/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  if (process.platform === "darwin") {
    const result = spawnSync("plutil", ["-lint", "--", join(home, "Library/LaunchAgents/local.cairn.viewer.plist")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
});

test("macOS rejects invalid installs, foreign jobs, and real launchctl failures", (t) => {
  const { run, calls, state } = macFixture(t);
  assert.throws(() => run("install", ":memory:"), /database file/);
  assert.throws(() => run("install", undefined, "65536"), /Port/);
  assert.deepEqual(calls, []);
  state.loaded = true;
  assert.throws(() => run("install"), /existing launchd job/);
  state.loaded = false;
  state.fail = "print";
  assert.throws(() => run("install"), /permission denied/);
  state.fail = "";
  const result = run("install");
  state.fail = "bootout";
  assert.throws(() => run("uninstall"), /permission denied/);
  assert.ok(existsSync(result.path));
  state.fail = "";
  writeFileSync(result.path, "foreign plist");
  assert.throws(() => run("install"), /not created by Cairn/);
});

test("Windows carries paths as literal data in encoded PowerShell commands", (t) => {
  const home = directory(t);
  let script = "";
  const runtime: ServiceRuntime = {
    home, node: "C:\\Program Files\\Node\\node.exe", uid: undefined,
    run(command, args) {
      assert.match(command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.ok(!args.includes("-ExecutionPolicy"));
      script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      return { status: 0, stdout: '{"installed":true}', stderr: "" };
    },
  };
  windowsService("install", join(home, "cli.js"), join(home, "á O'Brien $HOME %.sqlite"), "4318", runtime);
  const payload = script.match(/-WindowStyle Hidden -EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(payload);
  const viewer = Buffer.from(payload, "base64").toString("utf16le");
  assert.ok(viewer.includes("O''Brien $HOME %.sqlite"));
  assert.ok(viewer.includes("'--port' '4318'"));
  assert.ok(viewer.includes("exit $LASTEXITCODE"));
  assert.match(script, /-AtLogOn -User \$sid/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
  assert.throws(() => windowsService("install", "cli.js", ":memory:", undefined, runtime), /database file/);
  assert.throws(() => windowsService("install", "cli.js", undefined, "0", runtime), /Port/);
  runtime.run = () => ({ status: 1, stdout: "", stderr: "Task registration denied" });
  assert.throws(() => windowsService("install", "cli.js", undefined, undefined, runtime), /Task registration denied/);
});

// On Windows, execute the real PowerShell program and real ScheduledTasks object
// constructors, replacing only scheduler reads/writes with a temporary registry.
// This catches syntax and cmdlet parameter mistakes without installing a task.
test("Windows PowerShell executes lifecycle and preserves data with scheduler writes isolated", { skip: process.platform !== "win32" }, (t) => {
  const home = directory(t);
  const registry = join(home, "task.json");
  const db = join(home, "data.sqlite");
  writeFileSync(db, "keep");
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const stub = `
  $script:registry = ${ps(registry)}
  function Read-Task { if (Test-Path $script:registry) { Get-Content $script:registry -Raw | ConvertFrom-Json } }
  function Save-Task($value) { $value | ConvertTo-Json -Depth 10 | Set-Content $script:registry }
  function Get-ScheduledTask { param($TaskName, $TaskPath) Read-Task }
  function Register-ScheduledTask {
    param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force)
    if ($Principal.UserId -ne $sid) { throw 'Invalid task user' }
    $parseErrors = $null; $tokens = $null
    $payload = ($Action.Arguments -split ' ')[-1]
    $viewer = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload))
    [Management.Automation.Language.Parser]::ParseInput($viewer, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count) { throw $parseErrors[0].Message }
    Save-Task @{TaskName=$TaskName; Description=$Description; State='Ready'; Settings=@{Enabled=$true}}
  }
  function Enable-ScheduledTask { param($InputObject) $t=Read-Task; $t.Settings.Enabled=$true; Save-Task $t }
  function Disable-ScheduledTask { param($InputObject) $t=Read-Task; $t.Settings.Enabled=$false; Save-Task $t }
  function Start-ScheduledTask { param($InputObject, $TaskName, $TaskPath) $t=Read-Task; $t.State='Running'; Save-Task $t }
  function Stop-ScheduledTask { param($InputObject) $t=Read-Task; $t.State='Ready'; Save-Task $t }
  function Unregister-ScheduledTask { param($InputObject, $Confirm) Remove-Item $script:registry }
  function Get-ScheduledTaskInfo { param($InputObject) @{LastTaskResult=0} }
`;
  const runtime: ServiceRuntime = {
    home, node: process.execPath, uid: undefined,
    run(command, args) {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
        .replace("Import-Module ScheduledTasks -ErrorAction Stop", `Import-Module ScheduledTasks -ErrorAction Stop\n${stub}`);
      return spawnSync(command, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 30_000, windowsHide: true,
      });
    },
  };
  const run = (action: string) => windowsService(action, join(home, "cli.js"), db, "4318", runtime);
  assert.equal(run("status").installed, false);
  assert.throws(() => run("start"), /not installed/);
  assert.equal(run("install").active, "active");
  assert.equal(run("stop").startup, "disabled");
  assert.equal(run("status").active, "inactive");
  assert.equal(run("start").startup, "enabled");
  assert.equal(run("install").active, "active");
  assert.equal(run("uninstall").installed, false);
  assert.equal(readFileSync(db, "utf8"), "keep");
  assert.equal(run("uninstall").installed, false);
  run("install");
  const foreign = JSON.parse(readFileSync(registry, "utf8").replace(/^\uFEFF/, ""));
  foreign.Description = "not Cairn";
  writeFileSync(registry, JSON.stringify(foreign));
  assert.throws(() => run("uninstall"), /not created by Cairn/);
});
