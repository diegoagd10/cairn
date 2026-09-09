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

test("two-state frontier follows completion and preserves dependency ordering", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("First");
  const b = create("Second", [a.id]);
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [a.id],
  );
  assert.equal(a.status, "ready-for-agent");
  for (const status of ["todo", "in-progress", "cancelled", "unknown"])
    assert.throws(
      () => store.status(project.id, a.id, status),
      /Status must be/,
    );
  assert.throws(
    () => store.status(project.id, b.id, "done"),
    /Unfinished blockers/,
  );
  store.status(project.id, a.id, "done");
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [b.id],
  );
  store.status(project.id, b.id, "done");
  assert.throws(
    () => store.status(project.id, a.id, "ready-for-agent"),
    /dependent tickets/,
  );
  store.status(project.id, b.id, "ready-for-agent");
  store.status(project.id, a.id, "ready-for-agent");
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [a.id],
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

test("spec completion is explicit and requires done tickets", (t) => {
  const { store, project, create } = fixture(t);
  const spec = store.create(project.id, {
    kind: "spec",
    title: "Spec",
    body: "Outcome",
  });
  const ticket = create("Slice", [], spec.id);
  assert.throws(
    () => store.status(project.id, spec.id, "done"),
    /Finish the spec/,
  );
  store.status(project.id, ticket.id, "done");
  assert.equal(store.get(project.id, spec.id).status, "ready-for-agent");
  store.status(project.id, spec.id, "done");
  assert.throws(() => create("Extra", [], spec.id), /Reopen/);
  assert.throws(
    () => store.status(project.id, ticket.id, "ready-for-agent"),
    /Reopen/,
  );
  store.status(project.id, spec.id, "ready-for-agent");
  assert.equal(
    store.status(project.id, ticket.id, "ready-for-agent").status,
    "ready-for-agent",
  );
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

test("ready frontier uses status and ignores legacy labels", (t) => {
  const { store, project, create } = fixture(t);
  const a = create("Needs a human");
  store.update(project.id, a.id, { label: "ready-for-human" });
  assert.deepEqual(
    store.next(project.id).map((t) => t.id),
    [a.id],
  );
  store.status(project.id, a.id, "done");
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
  assert.equal(spec.status, "ready-for-agent");
  assert.equal(
    JSON.parse(cli("doc", "status", spec.id, "done").stdout).status,
    "done",
  );
  assert.equal(
    JSON.parse(cli("doc", "status", spec.id, "ready-for-agent").stdout).status,
    "ready-for-agent",
  );
  for (const status of ["todo", "in-progress", "cancelled"])
    assert.equal(cli("doc", "status", spec.id, status).status, 1);
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
  assert.doesNotMatch(
    response.headers.get("content-security-policy")!,
    /style-src[^;]*'unsafe-inline'/,
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

  const developmentServer = serve(store, { allowBrowserAnnotations: true });
  developmentServer.listen(0, "127.0.0.1");
  await once(developmentServer, "listening");
  t.after(() => {
    developmentServer.closeAllConnections();
    developmentServer.close();
  });
  const developmentBase = `http://127.0.0.1:${(developmentServer.address() as { port: number }).port}`;
  const developmentResponse = await fetch(developmentBase);
  assert.match(
    developmentResponse.headers.get("content-security-policy")!,
    /style-src 'self' 'unsafe-inline'/,
  );
  assert.match(
    developmentResponse.headers.get("content-security-policy")!,
    /script-src 'self'/,
  );
});

test("HTTP status changes persist, enforce dependencies and reject stale or unsafe writes", async (t) => {
  const { store, path, project, create } = fixture(t);
  const spec = store.create(project.id, {
    kind: "spec",
    title: "Outcome",
    body: "Original spec",
  });
  const first = create("First", [], spec.id);
  const second = create("Second", [first.id], spec.id);
  const server = serve(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Origin: base,
    "Content-Type": "application/json",
    "X-Cairn-Request": "status",
  };
  const endpoint = (id: string, projectId = project.id) =>
    `${base}/api/projects/${projectId}/documents/${id}/status`;
  const change = (
    id: string,
    status: string,
    revision = store.get(project.id, id).revision,
  ) =>
    fetch(endpoint(id), {
      method: "POST",
      headers,
      body: JSON.stringify({ status, revision }),
    });
  const original = store.get(project.id, first.id);

  for (const unsafe of [
    { ...headers, Origin: "https://evil.invalid" },
    { ...headers, Origin: "null" },
    { "Content-Type": "application/json", "X-Cairn-Request": "status" },
    { Origin: base, "Content-Type": "application/json" },
    { ...headers, "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal(
      (
        await fetch(endpoint(first.id), {
          method: "POST",
          headers: unsafe,
          body: JSON.stringify({ status: "done", revision: 1 }),
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(endpoint(first.id), {
        method: "POST",
        headers: { ...headers, "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
    415,
  );
  for (const body of [
    "null",
    "[]",
    "{",
    '{"status":"done"}',
    '{"status":"done","revision":0}',
    '{"status":"done","revision":1,"title":"Changed"}',
  ]) {
    assert.equal(
      (await fetch(endpoint(first.id), { method: "POST", headers, body }))
        .status,
      400,
    );
  }
  assert.equal(
    (
      await fetch(endpoint(first.id), {
        method: "POST",
        headers,
        body: " ".repeat(5000),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await fetch(endpoint(first.id, "another"), {
        method: "POST",
        headers,
        body: '{"status":"done","revision":1}',
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(endpoint(first.id), { method: "DELETE", headers })).status,
    405,
  );
  assert.equal((await change(first.id, "in-progress")).status, 400);
  assert.deepEqual(store.get(project.id, first.id), original);

  assert.equal((await change(second.id, "done")).status, 400);
  assert.equal((await change(spec.id, "done")).status, 400);
  const completed = await change(first.id, "done");
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, "done");
  assert.equal((await change(first.id, "ready-for-agent", 1)).status, 409);
  assert.equal(store.get(project.id, first.id).status, "done");
  const doneRevision = store.get(project.id, first.id).revision;
  assert.equal((await change(first.id, "done")).status, 200);
  assert.equal(store.get(project.id, first.id).revision, doneRevision);
  assert.equal((await change(second.id, "done")).status, 200);
  assert.equal((await change(spec.id, "done")).status, 200);
  const overview = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(overview[0].done, 2);
  assert.equal((await change(second.id, "ready-for-agent")).status, 400);
  assert.equal((await change(spec.id, "ready-for-agent")).status, 200);
  assert.equal((await change(first.id, "ready-for-agent")).status, 400);
  assert.equal((await change(second.id, "ready-for-agent")).status, 200);
  assert.equal((await change(first.id, "ready-for-agent")).status, 200);
  const reader = new Store(path);
  assert.equal(reader.get(project.id, first.id).status, "ready-for-agent");
  assert.equal(reader.get(project.id, first.id).body, original.body);
  reader.close();
});

test("HTTP content edits preserve Markdown, relationships and status for specs and tickets", async (t) => {
  const { store, path, project, create, cli } = fixture(t);
  const spec = store.create(project.id, { kind: "spec", title: "Plan", body: "Original" });
  const blocker = create("Blocker");
  const ticket = create("Step", [blocker.id], spec.id);
  store.comment(project.id, ticket.id, "Keep this note");
  const server = serve(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Origin: base, "Content-Type": "application/json", "X-Cairn-Request": "edit" };
  const markdown = '  # Updated · edición\r\n\r\n- [x] Done  \r\n\r\n<script>alert(1)</script><a href="javascript:alert(1)">bad</a>\r\n';
  for (const original of [spec, store.get(project.id, ticket.id)]) {
    const endpoint = `${base}/api/projects/${project.id}/documents/${original.id}`;
    const response = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ title: `${original.title} edited`, body: markdown, revision: original.revision }),
    });
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.title, `${original.title} edited`);
    assert.equal(updated.body, markdown);
    assert.equal(updated.revision, original.revision + 1);
    assert.equal(updated.status, original.status);
    assert.equal(updated.parent_id, original.parent_id);
    assert.deepEqual(updated.blockers, original.blockers);
    assert.deepEqual(updated.comments.map(({ html, ...comment }: { html: string }) => comment), original.comments.map((comment) => ({ ...comment })));
    assert.doesNotMatch(updated.html, /<script|javascript:/);
    assert.equal((await (await fetch(endpoint)).json()).body, markdown);
    assert.equal(cli("doc", "export", original.id).stdout, markdown);
    const reader = new Store(path);
    assert.equal(reader.get(project.id, original.id).body, markdown);
    reader.close();
    const stale = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ title: "Stale", body: "Lost update", revision: original.revision }),
    });
    assert.equal(stale.status, 409);
    assert.equal(store.get(project.id, original.id).body, markdown);
  }
  assert.equal(store.status(project.id, blocker.id, "done").status, "done");
  const beforeStatus = store.get(project.id, ticket.id);
  store.status(project.id, ticket.id, "done");
  const conflict = await fetch(`${base}/api/projects/${project.id}/documents/${ticket.id}`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Old revision", body: "Unsaved", revision: beforeStatus.revision }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(store.get(project.id, ticket.id).status, "done");
});

test("HTTP content edits reject unsafe requests and invalid fields without changing data", async (t) => {
  const { store, dir, project, create } = fixture(t);
  const ticket = create("Original");
  const otherRepo = join(dir, "other");
  execFileSync("git", ["init", "-b", "main", otherRepo], { stdio: "ignore" });
  const other = store.register(otherRepo);
  const server = serve(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const endpoint = `${base}/api/projects/${project.id}/documents/${ticket.id}`;
  const headers = { Origin: base, "Content-Type": "application/json", "X-Cairn-Request": "edit" };
  const patch = { title: "Edited", body: "# Markdown", revision: ticket.revision };
  for (const unsafe of [
    { ...headers, Origin: "https://evil.invalid" },
    { ...headers, Origin: "null" },
    { "Content-Type": "application/json", "X-Cairn-Request": "edit" },
    { Origin: base, "Content-Type": "application/json" },
    { ...headers, "X-Cairn-Request": "status" },
    { ...headers, "Sec-Fetch-Site": "cross-site" },
  ]) {
    assert.equal((await fetch(endpoint, { method: "POST", headers: unsafe, body: JSON.stringify(patch) })).status, 403);
  }
  assert.equal((await fetch(endpoint, {
    method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: JSON.stringify(patch),
  })).status, 415);
  for (const body of [
    "null", "[]", "{", "{}",
    ...[
      { ...patch, title: " " }, { ...patch, body: "\n\t" },
      { ...patch, title: null }, { ...patch, body: 12 },
      { ...patch, revision: undefined }, { ...patch, revision: 0 },
      { ...patch, revision: 1.5 }, { ...patch, revision: "1" },
      { ...patch, status: "done" }, { ...patch, blockers: [] },
      { ...patch, parent_id: null }, { ...patch, label: "changed" },
    ].map((value) => JSON.stringify(value)),
  ]) {
    assert.equal((await fetch(endpoint, { method: "POST", headers, body })).status, 400, body);
  }
  assert.equal((await fetch(`${base}/api/projects/${other.id}/documents/${ticket.id}`, {
    method: "POST", headers, body: JSON.stringify(patch),
  })).status, 400);
  assert.equal((await fetch(endpoint, { method: "DELETE", headers })).status, 405);
  assert.equal((await fetch(endpoint, {
    method: "POST", headers, body: JSON.stringify({ ...patch, body: "a".repeat(1024 * 1024) }),
  })).status, 413);
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint, { method: "POST", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.write(" ".repeat(600_000));
    req.end(" ".repeat(600_000));
  });
  assert.equal(chunked, 413);
  assert.deepEqual(store.get(project.id, ticket.id), ticket);
  // Ordinary Markdown documents are much larger than a status request.
  assert.equal((await fetch(endpoint, {
    method: "POST", headers, body: JSON.stringify({ ...patch, body: "é".repeat(6000) }),
  })).status, 200);
});
