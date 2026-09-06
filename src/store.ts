import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { repository } from "./repo.ts";

export const statuses = ["todo", "in-progress", "done", "cancelled"] as const;
export type Status = (typeof statuses)[number];
export type Kind = "spec" | "ticket";
export type Project = {
  id: string;
  name: string;
  identity: string;
  remote: string;
  created_at: string;
};
export type Document = {
  id: string;
  project_id: string;
  kind: Kind;
  title: string;
  body: string;
  status: Status;
  label: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};
export type Detail = Document & {
  blockers: string[];
  unresolved: string[];
  comments: { id: number; body: string; created_at: string }[];
};
type Create = {
  kind: Kind;
  title: string;
  body: string;
  parent?: string;
  blockers?: string[];
  label?: string;
};
export const defaultDatabase = () =>
  process.env.CAIRN_DB ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "cairn",
    "cairn.sqlite",
  );

function required(value: string, field: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must not be empty.`);
  return value;
}

export class Store {
  db: DatabaseSync;
  path: string;
  constructor(path = defaultDatabase()) {
    this.path = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:")
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    if (path !== ":memory:") chmodSync(this.path, 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error("This database needs a newer version of Cairn.");
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, identity TEXT NOT NULL UNIQUE,
        remote TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS locations (common_dir TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK(kind IN ('spec','ticket')), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in-progress','done','cancelled')),
        label TEXT NOT NULL DEFAULT 'ready-for-agent', parent_id TEXT REFERENCES documents(id),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS blockers (
        ticket_id TEXT NOT NULL REFERENCES documents(id), blocker_id TEXT NOT NULL REFERENCES documents(id),
        PRIMARY KEY(ticket_id,blocker_id), CHECK(ticket_id <> blocker_id)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id,kind);
      CREATE INDEX IF NOT EXISTS comments_document ON comments(document_id);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name,id")
      .all() as Project[];
  }
  project(ref: string): Project {
    const matches = this.db
      .prepare("SELECT * FROM projects WHERE id=? OR name=?")
      .all(ref, ref) as Project[];
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Ambiguous project name: ${ref}. Use its ID.`
          : `Project not found: ${ref}. Run cairn project add.`,
      );
    return matches[0]!;
  }
  register(directory: string, name?: string): Project {
    const repo = repository(directory);
    if (name !== undefined) required(name, "Name");
    return this.transaction(() => {
      const location = this.db
        .prepare("SELECT project_id FROM locations WHERE common_dir=?")
        .get(repo.commonDir);
      const existing = location
        ? this.project(String(location.project_id))
        : (this.db
            .prepare("SELECT * FROM projects WHERE identity=?")
            .get(repo.identity) as Project | undefined);
      const id = existing?.id || randomUUID();
      if (!existing)
        this.db
          .prepare(
            "INSERT INTO projects(id,name,identity,remote) VALUES(?,?,?,?)",
          )
          .run(id, name || repo.name, repo.identity, repo.remote);
      else {
        // Keep a local repository's identity stable when its origin is first configured.
        const conflict = this.db
          .prepare("SELECT id FROM projects WHERE identity=? AND id<>?")
          .get(repo.identity, id);
        if (conflict)
          throw new Error(
            "This remote is already registered to another project; use --project to choose it.",
          );
        this.db
          .prepare("UPDATE projects SET identity=?,remote=?,name=? WHERE id=?")
          .run(repo.identity, repo.remote, name || existing.name, id);
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO locations(common_dir,project_id) VALUES(?,?)",
        )
        .run(repo.commonDir, id);
      return this.project(id);
    });
  }
  resolveProject(ref?: string, cwd = process.cwd()): Project {
    if (ref) return this.project(ref);
    const repo = repository(cwd);
    const match = this.db
      .prepare(
        "SELECT project_id AS id FROM locations WHERE common_dir=? UNION SELECT id FROM projects WHERE identity=?",
      )
      .all(repo.commonDir, repo.identity);
    if (match.length !== 1)
      throw new Error(
        match.length
          ? "Repository identity is ambiguous. Select --project explicitly."
          : "Repository is not registered. Run cairn project add.",
      );
    return this.project(String(match[0]!.id));
  }
  get(projectId: string, id: string): Detail {
    const doc = this.db
      .prepare("SELECT * FROM documents WHERE project_id=? AND id=?")
      .get(projectId, id) as Document | undefined;
    if (!doc) throw new Error(`Document not found in this project: ${id}`);
    const blockers = this.db
      .prepare(
        "SELECT d.id,d.status FROM blockers b JOIN documents d ON d.id=b.blocker_id WHERE b.ticket_id=? ORDER BY d.id",
      )
      .all(id);
    const comments = this.db
      .prepare(
        "SELECT id,body,created_at FROM comments WHERE document_id=? ORDER BY id",
      )
      .all(id) as Detail["comments"];
    return {
      ...doc,
      blockers: blockers.map((b) => String(b.id)),
      unresolved: blockers
        .filter((b) => b.status !== "done")
        .map((b) => String(b.id)),
      comments,
    };
  }
  list(projectId: string, kind?: Kind): Detail[] {
    this.project(projectId);
    return this.db
      .prepare(
        "SELECT id FROM documents WHERE project_id=? AND (? IS NULL OR kind=?) ORDER BY created_at,id",
      )
      .all(projectId, kind || null, kind || null)
      .map((row) => this.get(projectId, String(row.id)));
  }
  create(projectId: string, input: Create): Detail {
    return this.transaction(() => {
      this.project(projectId);
      required(input.title, "Title");
      required(input.body, "Body");
      if (!["spec", "ticket"].includes(input.kind))
        throw new Error("Invalid document kind.");
      if (input.parent) {
        if (
          input.kind !== "ticket" ||
          this.get(projectId, input.parent).kind !== "spec"
        )
          throw new Error(
            "A ticket parent must be a spec in the same project.",
          );
        if (
          ["done", "cancelled"].includes(
            this.get(projectId, input.parent).status,
          )
        )
          throw new Error("Reopen the parent spec before adding a ticket.");
      }
      const id = `${input.kind === "spec" ? "SPEC" : "TKT"}-${randomUUID().slice(0, 8)}`;
      this.db
        .prepare(
          "INSERT INTO documents(id,project_id,kind,title,body,parent_id,label) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          projectId,
          input.kind,
          input.title.trim(),
          input.body,
          input.parent || null,
          required(input.label ?? "ready-for-agent", "Label"),
        );
      this.replaceBlockers(projectId, id, input.blockers || []);
      return this.get(projectId, id);
    });
  }
  private replaceBlockers(projectId: string, id: string, refs: string[]) {
    const doc = this.get(projectId, id);
    if (refs.length && doc.kind !== "ticket")
      throw new Error("Only tickets can have blockers.");
    for (const ref of new Set(refs)) {
      const blocker = this.get(projectId, ref);
      if (blocker.kind !== "ticket" || ref === id)
        throw new Error("Blockers must be other tickets in this project.");
      if (
        ["in-progress", "done"].includes(doc.status) &&
        blocker.status !== "done"
      )
        throw new Error(
          "An active or finished ticket cannot gain unfinished blockers.",
        );
      const cycle = this.db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
        SELECT blocker_id FROM blockers WHERE ticket_id=? UNION SELECT b.blocker_id FROM blockers b JOIN ancestors a ON b.ticket_id=a.id
      ) SELECT id FROM ancestors WHERE id=?`,
        )
        .get(ref, id);
      if (cycle) throw new Error("This dependency would create a cycle.");
    }
    this.db.prepare("DELETE FROM blockers WHERE ticket_id=?").run(id);
    for (const ref of new Set(refs))
      this.db
        .prepare("INSERT INTO blockers(ticket_id,blocker_id) VALUES(?,?)")
        .run(id, ref);
  }
  update(
    projectId: string,
    id: string,
    patch: {
      title?: string;
      body?: string;
      label?: string;
      blockers?: string[];
      revision?: number;
    },
  ): Detail {
    return this.transaction(() => {
      const doc = this.get(projectId, id);
      if (patch.revision !== undefined && patch.revision !== doc.revision)
        throw new Error(
          "Revision conflict. Read the document again before editing.",
        );
      if (patch.blockers) this.replaceBlockers(projectId, id, patch.blockers);
      this.db
        .prepare(
          "UPDATE documents SET title=?,body=?,label=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        )
        .run(
          required(patch.title ?? doc.title, "Title"),
          required(patch.body ?? doc.body, "Body"),
          required(patch.label ?? doc.label, "Label"),
          id,
        );
      return this.get(projectId, id);
    });
  }
  status(projectId: string, id: string, status: string): Detail {
    if (!statuses.includes(status as Status))
      throw new Error(`Status must be ${statuses.join(", ")}.`);
    return this.transaction(() => {
      const doc = this.get(projectId, id);
      if (
        doc.kind === "ticket" &&
        ["in-progress", "done"].includes(status) &&
        doc.unresolved.length
      )
        throw new Error(`Unfinished blockers: ${doc.unresolved.join(", ")}`);
      if (
        doc.kind === "spec" &&
        ["done", "cancelled"].includes(status) &&
        this.list(projectId, "ticket").some(
          (t) =>
            t.parent_id === id && !["done", "cancelled"].includes(t.status),
        )
      )
        throw new Error(
          "Finish or cancel the spec’s tickets before closing it.",
        );
      if (doc.status === "done" && status !== "done") {
        const dependents = this.db
          .prepare(
            "SELECT d.id FROM blockers b JOIN documents d ON d.id=b.ticket_id WHERE b.blocker_id=? AND d.status IN ('in-progress','done')",
          )
          .all(id);
        if (dependents.length)
          throw new Error(
            "Move active or finished dependent tickets to todo before reopening this blocker.",
          );
      }
      if (
        doc.parent_id &&
        !["done", "cancelled"].includes(status) &&
        ["done", "cancelled"].includes(
          this.get(projectId, doc.parent_id).status,
        )
      )
        throw new Error("Reopen the parent spec first.");
      this.db
        .prepare(
          "UPDATE documents SET status=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        )
        .run(status, id);
      return this.get(projectId, id);
    });
  }
  comment(projectId: string, id: string, body: string) {
    this.get(projectId, id);
    this.db
      .prepare("INSERT INTO comments(document_id,body) VALUES(?,?)")
      .run(id, required(body, "Comment"));
    return this.get(projectId, id);
  }
  next(projectId: string) {
    return this.list(projectId, "ticket").filter(
      (t) =>
        t.status === "todo" &&
        t.label === "ready-for-agent" &&
        !t.unresolved.length,
    );
  }
  export(projectId: string) {
    return {
      format: "cairn/v1",
      project: this.project(projectId),
      documents: this.list(projectId),
    };
  }
  async backup(destination: string) {
    const target = resolve(destination);
    // Exclusive creation prevents accidental replacement of an existing backup.
    const { openSync, closeSync, unlinkSync } = await import("node:fs");
    const fd = openSync(target, "wx", 0o600);
    closeSync(fd);
    try {
      await backup(this.db, target);
    } catch (error) {
      unlinkSync(target);
      throw error;
    }
    return { path: target };
  }
}
