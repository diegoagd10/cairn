import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

function legacy(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "v1.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"),
  );
  db.exec(
    "INSERT INTO projects(id,name,identity,remote,created_at) VALUES('p','Project','local:project','','2026-01-01'); INSERT INTO locations VALUES('/repo/.git','p');",
  );
  return { path, db };
}

test("v1 migration keeps Markdown, relationships, labels, comments and completed work", (t) => {
  const { path, db } = legacy(t);
  const body =
    '# Español 🪨\r\n\n- [ ] Keep this\n\n```js\nconst x = "$HOME";\n```\n';
  const add = db.prepare(
    "INSERT INTO documents(id,project_id,kind,title,body,status,label,parent_id) VALUES(?,'p',?,?,?,?,'needs-info',?)",
  );
  add.run("SPEC-parent", "spec", "Parent", body, "done", null);
  add.run(
    "TKT-cancelled",
    "ticket",
    "Cancelled",
    body,
    "cancelled",
    "SPEC-parent",
  );
  add.run("TKT-done", "ticket", "Done", body, "done", null);
  add.run("TKT-active", "ticket", "Active", body, "in-progress", null);
  add.run("TKT-todo", "ticket", "Todo", body, "todo", null);
  db.exec(
    "INSERT INTO blockers VALUES('TKT-todo','TKT-cancelled'); INSERT INTO comments(document_id,body) VALUES('TKT-todo','A note');",
  );
  db.close();

  const store = new Store(path);
  const snapshot = store.export("p");
  assert.equal(snapshot.documents.length, 5);
  assert.ok(
    snapshot.documents.every(
      (doc) => doc.body === body && doc.label === "needs-info",
    ),
  );
  assert.equal(store.get("p", "TKT-done").status, "done");
  assert.equal(store.get("p", "TKT-done").revision, 1);
  for (const id of ["SPEC-parent", "TKT-cancelled", "TKT-active", "TKT-todo"]) {
    assert.equal(store.get("p", id).status, "ready-for-agent");
    assert.equal(store.get("p", id).revision, 2);
  }
  assert.equal(store.get("p", "TKT-cancelled").parent_id, "SPEC-parent");
  assert.deepEqual(store.get("p", "TKT-todo").unresolved, ["TKT-cancelled"]);
  assert.equal(store.get("p", "TKT-todo").comments[0]!.body, "A note");
  assert.equal(
    store.db.prepare("SELECT project_id FROM locations").get()!.project_id,
    "p",
  );
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 2);
  assert.throws(
    () => store.db.exec("UPDATE documents SET status='todo'"),
    /CHECK/,
  );
  assert.throws(
    () => store.db.exec("INSERT INTO blockers VALUES('missing','TKT-done')"),
    /FOREIGN KEY/,
  );
  store.close();
  const reopened = new Store(path);
  assert.deepEqual(
    reopened.export("p"),
    snapshot,
    "reopening does not rerun migration",
  );
  reopened.close();
});

test("failed migration rolls back schema and status changes", (t) => {
  const { path, db } = legacy(t);
  db.exec(
    "PRAGMA foreign_keys=OFF; INSERT INTO documents(id,project_id,kind,title,body,status) VALUES('bad','missing','ticket','Bad','Original','todo');",
  );
  db.close();
  assert.throws(() => new Store(path), /invalid document relationships/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(
    check.prepare("SELECT status FROM documents").get()!.status,
    "todo",
  );
  check.close();
});
