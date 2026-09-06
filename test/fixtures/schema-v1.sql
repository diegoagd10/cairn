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
    
