import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { normalizeRemote } from "../src/repo.ts";
import { serve } from "../src/server.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-test-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  const path = join(dir, "data", "cairn.sqlite");
  const store = new Store(path);
  const project = store.register(repo);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const create = (title: string, blockers: string[] = [], parent?: string) =>
    store.create(project.id, {
      kind: "ticket",
      title,
      body: `## What to build\n\n${title}\n\n- [ ] It works.\n`,
      blockers,
      parent,
    });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [cliPath, "--db", path, ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  return { dir, repo, path, store, project, create, cli };
}

test("frontier follows completion and cancellation keeps blockers unresolved", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("First");
  const b = create("Second", [a.id]);
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [a.id],
  );
  assert.throws(
    () => store.status(project.id, b.id, "in-progress"),
    /Unfinished blockers/,
  );
  assert.throws(
    () => store.status(project.id, b.id, "done"),
    /Unfinished blockers/,
  );
  store.status(project.id, a.id, "cancelled");
  assert.deepEqual(store.next(project.id), []);
  store.status(project.id, a.id, "done");
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [b.id],
  );
  store.status(project.id, b.id, "in-progress");
  assert.throws(
    () => store.status(project.id, a.id, "todo"),
    /dependent tickets/,
  );
});

test("cycles and invalid blockers roll back without losing existing edges", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("A");
  const b = create("B", [a.id]);
  const c = create("C", [b.id]);
  assert.throws(
    () => store.update(project.id, a.id, { blockers: [c.id] }),
    /cycle/,
  );
  assert.throws(
    () => store.update(project.id, b.id, { blockers: ["TKT-missing"] }),
    /not found/,
  );
  assert.deepEqual(store.get(project.id, b.id).blockers, [a.id]);
  assert.throws(() => create("Bad", [c.id, "TKT-missing"]), /not found/);
  assert.equal(store.list(project.id).length, 3);
  assert.throws(
    () => store.update(project.id, a.id, { blockers: [a.id] }),
    /other tickets/,
  );
});

test("projects isolate reads, parents, comments and dependencies", (t) => {
  const { dir, store, project, create } = fixture(t);
  const otherRepo = join(dir, "other");
  mkdirSync(otherRepo);
  execFileSync("git", ["init", otherRepo], { stdio: "ignore" });
  const other = store.register(otherRepo);
  const a = create("Private ticket");
  const spec = store.create(project.id, {
    kind: "spec",
    title: "Destination",
    body: "Private spec",
  });
  assert.throws(() => store.get(other.id, a.id), /not found/);
  assert.throws(() => store.comment(other.id, a.id, "Leak"), /not found/);
  assert.throws(
    () =>
      store.create(other.id, {
        kind: "ticket",
        title: "Other",
        body: "Other",
        blockers: [a.id],
      }),
    /not found/,
  );
  assert.throws(
    () =>
      store.create(other.id, {
        kind: "ticket",
        title: "Other",
        body: "Other",
        parent: spec.id,
      }),
    /not found/,
  );
  assert.deepEqual(store.list(other.id), []);
});

test("spec completion is explicit and requires terminal tickets", (t) => {
  const { store, project, create } = fixture(t);
  const spec = store.create(project.id, {
    kind: "spec",
    title: "Spec",
    body: "Outcome",
  });
  const ticket = create("Slice", [], spec.id);
  assert.throws(
    () => store.status(project.id, spec.id, "done"),
    /Finish or cancel/,
  );
  assert.throws(
    () => store.status(project.id, spec.id, "cancelled"),
    /Finish or cancel/,
  );
  store.status(project.id, ticket.id, "done");
  assert.equal(store.get(project.id, spec.id).status, "todo");
  store.status(project.id, spec.id, "done");
  assert.throws(() => create("Extra", [], spec.id), /Reopen/);
  assert.throws(() => store.status(project.id, ticket.id, "todo"), /Reopen/);
});

test("Markdown, notes, revisions and exports persist across connections", (t) => {
  const { store, path, project } = fixture(t);
  const body =
    '# Español 🪨\r\n\r\n- [ ] Done\n\n```ts\nconst a = "$HOME";\n```\n';
  const spec = store.create(project.id, {
    kind: "spec",
    title: "Unicode",
    body,
  });
  store.comment(project.id, spec.id, "A decision");
  store.update(project.id, spec.id, { title: "New title", revision: 1 });
  assert.throws(
    () => store.update(project.id, spec.id, { body: "Stale", revision: 1 }),
    /Revision conflict/,
  );
  const reader = new Store(path);
  try {
    assert.equal(reader.get(project.id, spec.id).body, body);
    assert.equal(
      reader.get(project.id, spec.id).comments[0]!.body,
      "A decision",
    );
    assert.equal(reader.export(project.id).documents[0]!.body, body);
    assert.equal(reader.get(project.id, spec.id).revision, 2);
  } finally {
    reader.close();
  }
});

test("worktrees, nested directories, symlink-independent common dirs and origin transport share identity", (t) => {
  const { dir, repo, store, project } = fixture(t);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ],
    { stdio: "ignore" },
  );
  const worktree = join(dir, "worktree");
  execFileSync(
    "git",
    ["-C", repo, "worktree", "add", "-b", "feature", worktree],
    { stdio: "ignore" },
  );
  assert.equal(store.register(worktree).id, project.id);
  const nested = join(worktree, "src");
  mkdirSync(nested);
  assert.equal(store.resolveProject(undefined, nested).id, project.id);
  const alias = join(dir, "alias");
  symlinkSync(worktree, alias);
  assert.equal(store.resolveProject(undefined, alias).id, project.id);
  execFileSync("git", [
    "-C",
    repo,
    "remote",
    "add",
    "origin",
    "git@github.com:someone/example.git",
  ]);
  assert.equal(store.register(repo).id, project.id);
  const clone = join(dir, "clone");
  mkdirSync(clone);
  execFileSync("git", ["init", clone], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    clone,
    "remote",
    "add",
    "origin",
    "https://github.com/someone/example.git",
  ]);
  assert.equal(store.register(clone).id, project.id);
  assert.equal(store.projects().length, 1);
});

test("remote normalization strips credentials and handles common transports", () => {
  assert.equal(
    normalizeRemote("git@github.com:owner/repo.git"),
    "github.com/owner/repo",
  );
  assert.equal(
    normalizeRemote("https://user:secret@github.com/owner/repo.git"),
    "github.com/owner/repo",
  );
  assert.equal(
    normalizeRemote("ssh://git@github.com/owner/repo.git"),
    "github.com/owner/repo",
  );
  assert.equal(normalizeRemote("/tmp/local/repo"), "");
});

test("ambiguous project names require explicit IDs", (t) => {
  const { dir, store, project } = fixture(t);
  const other = join(dir, "other");
  mkdirSync(other);
  execFileSync("git", ["init", other], { stdio: "ignore" });
  store.register(other, project.name);
  assert.throws(() => store.project(project.name), /Ambiguous/);
  assert.equal(store.project(project.id).id, project.id);
});

test("ready frontier respects triage label and status", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("Needs a human");
  store.update(project.id, a.id, { label: "ready-for-human" });
  assert.deepEqual(store.next(project.id), []);
  store.update(project.id, a.id, { label: "ready-for-agent" });
  store.status(project.id, a.id, "in-progress");
  assert.deepEqual(store.next(project.id), []);
});

test("failed edits are atomic and finished tickets cannot gain unfinished blockers", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("A");
  const b = create("B");
  assert.throws(
    () => store.update(project.id, b.id, { blockers: [a.id], title: "" }),
    /empty/,
  );
  assert.deepEqual(store.get(project.id, b.id).blockers, []);
  store.status(project.id, b.id, "done");
  assert.throws(
    () => store.update(project.id, b.id, { blockers: [a.id] }),
    /unfinished blockers/,
  );
});

test("backup captures a consistent restorable database and refuses overwrite", async (t) => {
  const { dir, store, project, create } = fixture(t);
  const ticket = create("Back me up");
  const target = join(dir, "backup.sqlite");
  await store.backup(target);
  const backup = new Store(target);
  try {
    assert.equal(backup.get(project.id, ticket.id).title, "Back me up");
  } finally {
    backup.close();
  }
  await assert.rejects(store.backup(target), /EEXIST/);
});

test("CLI creates through stdin, returns structured data, reads and exports exact Markdown", (t) => {
  const { repo, path, cli } = fixture(t);
  const body = "# A spec\n\n- [ ] Keep original whitespace.\n";
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--db",
      path,
      "spec",
      "create",
      "--title",
      "CLI spec",
      "--body-file",
      "-",
    ],
    { cwd: repo, input: body, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const spec = JSON.parse(result.stdout);
  assert.equal(spec.body, body);
  assert.equal(cli("doc", "export", spec.id).stdout, body);
  assert.equal(JSON.parse(cli("doc", "get", spec.id).stdout).title, "CLI spec");
  assert.equal(cli("doc", "status", spec.id, "done", "extra").status, 1);
  assert.equal(cli("spec", "list", "--title", "ignored?").status, 1);
  assert.equal(cli("ticket", "create", "--title", "Missing body").status, 1);
  const errorLine = cli("doc", "get", "TKT-nope")
    .stderr.split("\n")
    .find((line) => line.startsWith("{"))!;
  assert.match(JSON.parse(errorLine).error, /not found/);
});

test("CLI project export refuses to overwrite existing files", (t) => {
  const { dir, cli, create } = fixture(t);
  create("Export me");
  const file = join(dir, "archive.json");
  assert.equal(cli("export", "--output", file).status, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).format, "cairn/v1");
  assert.equal(cli("export", "--output", file).status, 1);
});

test("HTTP viewer renders sanitized Markdown, reads fresh data, isolates projects and rejects writes/origins", async (t) => {
  const { store, project, create } = fixture(t);
  const ticket = create("First");
  store.update(project.id, ticket.id, {
    body: '# Safe heading\n\n- [x] Finished\n\n<script>alert(1)</script><img src="https://example.invalid/tracker"><a href="javascript:alert(1)">bad</a><input type="text" autofocus onfocus="alert(1)">',
  });
  const server = serve(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(
    `${base}/api/projects/${project.id}/documents/${ticket.id}`,
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  const doc = await response.json();
  assert.match(doc.html, /<h1>Safe heading<\/h1>/);
  assert.doesNotMatch(doc.html, /<script|<img|javascript:|autofocus|onfocus/);
  assert.match(doc.html, /disabled/);
  const b = create("Fresh data");
  const list = await (
    await fetch(`${base}/api/projects/${project.id}/documents`)
  ).json();
  assert.equal(list.length, 2);
  assert.equal(Object.hasOwn(list[0], "body"), false);
  assert.equal(
    (await fetch(`${base}/api/projects/another/documents/${b.id}`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/projects`, { method: "POST" })).status,
    405,
  );
  assert.equal(
    (
      await fetch(`${base}/api/projects`, {
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${base}/api/projects`,
      { headers: { Host: "evil.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${base}/not-an-asset`)).status, 404);
  assert.match(await (await fetch(base)).text(), /Your path, mapped/);
});
