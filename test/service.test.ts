import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const linux = { skip: process.platform !== "linux" };

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.jsonl");
  const state = join(dir, "state.json");
  // Exercise the CLI boundary without touching the user's real service manager.
  writeFileSync(join(bin, "systemctl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SERVICE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== '--user') process.exit(20);
if (args[1] === process.env.SERVICE_TEST_FAIL) {
  console.error('simulated systemd failure');
  process.exit(1);
}
const path = process.env.SERVICE_TEST_STATE;
const state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { active: false, enabled: false };
if (args[1] === 'enable') { state.enabled = true; if (args.includes('--now')) state.active = true; }
if (args[1] === 'disable') { state.enabled = false; if (args.includes('--now')) state.active = false; }
if (args[1] === 'restart') state.active = true;
fs.writeFileSync(path, JSON.stringify(state));
if (args[1] === 'show') {
  console.log('ActiveState=' + (state.active ? 'active' : 'inactive'));
  console.log('SubState=' + (state.active ? 'running' : 'dead'));
  console.log('UnitFileState=' + (state.enabled ? 'enabled' : 'disabled'));
}
`, { mode: 0o700 });
  const config = join(dir, "config");
  const data = join(dir, "data");
  const path = join(config, "systemd/user/cairn.service");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    CAIRN_DB: "",
    SERVICE_TEST_LOG: log,
    SERVICE_TEST_STATE: state,
  };
  const run = (args: string[], overrides: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, "service", ...args], {
      cwd: dir, env: { ...env, ...overrides }, encoding: "utf8",
    });
  const ok = (...args: string[]) => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { dir, data, path, run, ok, calls };
}

test("service lifecycle enables startup, stops persistently, and preserves data on uninstall", linux, (t) => {
  const { data, path, ok, calls } = fixture(t);
  assert.equal(ok("status").installed, false);
  assert.deepEqual(calls(), []);
  const installed = ok("install");
  assert.equal(installed.active, "active");
  assert.equal(installed.startup, "enabled");
  assert.ok(readFileSync(path, "utf8").includes(join(data, "cairn/cairn.sqlite")));
  assert.equal(existsSync(data), false, "service management must not open or create a database");
  const stopped = ok("stop");
  assert.equal(stopped.active, "inactive");
  assert.equal(stopped.startup, "disabled");
  assert.equal(ok("status").active, "inactive");
  const started = ok("start");
  assert.equal(started.active, "active");
  assert.equal(started.startup, "enabled");
  mkdirSync(join(data, "cairn"), { recursive: true });
  const database = join(data, "cairn/cairn.sqlite");
  writeFileSync(database, "keep this data");
  assert.equal(ok("uninstall").installed, false);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(database, "utf8"), "keep this data");
  assert.equal(ok("uninstall").installed, false);
  assert.ok(calls().every((args) => args[0] === "--user"));
});

test("install persists custom paths safely and can replace its own settings", linux, (t) => {
  const { dir, path, ok, run } = fixture(t);
  ok("install", "--port", "4318", "--db", 'notes %h $HOME "quoted" \\ data.sqlite');
  const unit = readFileSync(path, "utf8");
  assert.ok(unit.includes('ExecStart=:"'));
  assert.ok(unit.includes('notes %%h $HOME \\"quoted\\" \\\\ data.sqlite'));
  assert.ok(unit.includes('"--port" "4318"'));
  assert.ok(unit.includes(dir));
  // Let systemd itself parse the generated unit when its validation tool exists.
  const verify = spawnSync("systemd-analyze", ["--user", "verify", path], { encoding: "utf8" });
  if (!verify.error) assert.equal(verify.status, 0, verify.stderr);
  const result = run(["install"], { CAIRN_DB: "from-environment.sqlite" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(path, "utf8").includes(join(dir, "from-environment.sqlite")));
  assert.ok(readFileSync(path, "utf8").includes('"--port" "4317"'));
});

test("bad service arguments have no side effects", linux, (t) => {
  const { run, calls, path, data } = fixture(t);
  for (const args of [
    [], ["unknown"], ["install", "extra"], ["install", "--port", "0"],
    ["install", "--port", "65536"], ["install", "--port", "abc"],
    ["install", "--db", ":memory:"], ["install", "--db", "bad\npath"],
    ["install", "--project", "cairn"], ["stop", "--port", "4318"],
    ["status", "--db", "unexpected.sqlite"], ["start"], ["stop"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error);
  }
  assert.deepEqual(calls(), []);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(data), false);
});

test("unmanaged service files and symlinks are preserved", linux, (t) => {
  const { dir, path, run, calls } = fixture(t);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "unrelated unit\n");
  for (const action of ["install", "start", "stop", "uninstall"]) {
    const result = run([action]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not created by Cairn/);
    assert.equal(readFileSync(path, "utf8"), "unrelated unit\n");
  }
  rmSync(path);
  const target = join(dir, "other.service");
  writeFileSync(target, "# Managed by cairn service install\n");
  symlinkSync(target, path);
  assert.equal(run(["install"]).status, 1);
  assert.equal(readFileSync(target, "utf8"), "# Managed by cairn service install\n");
  assert.deepEqual(calls(), []);
});

test("systemd failures return errors and failed uninstall preserves the unit", linux, (t) => {
  const { path, run, ok } = fixture(t);
  const unavailable = run(["install"], { SERVICE_TEST_FAIL: "show-environment" });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /simulated systemd failure/);
  assert.equal(existsSync(path), false);
  ok("install");
  const failure = run(["uninstall"], { SERVICE_TEST_FAIL: "disable" });
  assert.equal(failure.status, 1);
  assert.ok(existsSync(path));
  const restart = run(["install"], { SERVICE_TEST_FAIL: "restart" });
  assert.equal(restart.status, 1);
  assert.match(restart.stderr, /journalctl/);
});
