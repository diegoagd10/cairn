import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

test("production install runs the built CLI and serves assets and persisted data outside the checkout", { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cairn-deployment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = join(directory, "app");
  const repo = join(directory, "repo");
  mkdirSync(app);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  for (const file of ["package.json", "pnpm-lock.yaml", "dist", "web"]) {
    cpSync(new URL(`../${file}`, import.meta.url), join(app, file), { recursive: true });
  }
  assert.ok(process.env.npm_execpath, "Run through pnpm test:deployment");
  execFileSync(process.execPath, [process.env.npm_execpath, "install", "--prod", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: app, stdio: "pipe", timeout: 90_000,
  });
  const database = join(directory, "data", "cairn.sqlite");
  const cli = (...args: string[]) => execFileSync(process.execPath, [join(app, "dist", "cli.js"), "--db", database, ...args], {
    cwd: repo, encoding: "utf8",
  });
  assert.match(cli("--help"), /Cairn/);
  cli("project", "add", ".");
  const body = "# Deployment\n\nSaved Markdown. <script>alert(1)</script>\n";
  const bodyPath = join(directory, "body.md");
  writeFileSync(bodyPath, body);
  const document = JSON.parse(cli("spec", "create", "--title", "Deployment smoke", "--body-file", bodyPath));
  assert.equal(JSON.parse(cli("doc", "get", document.id)).body, body);

  const source = `
    import { Store } from ${JSON.stringify(pathToFileURL(join(app, "dist", "store.js")).href)};
    import { serve } from ${JSON.stringify(pathToFileURL(join(app, "dist", "server.js")).href)};
    const store = new Store(${JSON.stringify(database)});
    const server = serve(store);
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  t.after(async () => { child.kill(); await exited; });
  const lines = createInterface({ input: child.stdout });
  const port = await Promise.race([
    once(lines, "line").then(([line]) => Number(line)),
    exited.then(() => { throw new Error(`Deployment server exited: ${errors}`); }),
  ]);
  assert.ok(Number.isInteger(port) && port > 0);
  const base = `http://127.0.0.1:${port}`;
  for (const path of ["/", "/app.js", "/style.css", "/favicon.svg"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
  }
  const projects = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(projects.length, 1);
  const response = await fetch(`${base}/api/projects/${projects[0].id}/documents/${document.id}`);
  assert.equal(response.status, 200);
  const served = await response.json();
  assert.equal(served.body, body);
  assert.doesNotMatch(served.html, /<script>/);
});
