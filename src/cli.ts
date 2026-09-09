#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { Store } from "./store.ts";
import type { Kind } from "./store.ts";
import { serve } from "./server.ts";

const help = `Cairn — personal specs and tickets for every repository

Usage: cairn <command> [options]

  project add [path] [--name NAME]       Register a Git repo (default: current dir)
  project list                         List all registered projects
  project resolve                      Resolve the current repo or --project
  spec create --title TEXT --body-file PATH
  ticket create --title TEXT --body-file PATH [--parent SPEC-ID] [--blocked-by IDS]
  spec list | ticket list              List documents, including full Markdown
  doc get ID                           Read a document, blockers, and comments
  doc update ID [--title TEXT] [--body-file PATH] [--label LABEL]
                [--blocked-by IDS] [--revision N]
  doc status ID ready-for-agent|done
  doc export ID                        Write original Markdown to stdout
  comment add ID --body-file PATH       Append context to a document
  next                                 List ready-for-agent tickets with completed blockers
  export [--output PATH]               Export current project as JSON (exclusive file)
  backup --output PATH                 Create a consistent SQLite backup
  serve [--port 4317]                   Run the local viewer in the foreground

Options:
  --project ID_OR_NAME  Select a project explicitly; otherwise resolve current repo
  --db PATH            Database path (or CAIRN_DB; default: XDG data dir/cairn/cairn.sqlite)
  --label LABEL        Legacy metadata; does not affect status or ready tickets
  --blocked-by IDS     Comma-separated ticket IDs; use "" to clear blockers
  --body-file -        Read Markdown from stdin; content is stored unchanged
  --json              Explicit JSON mode (already the default for data commands)
  --help              Show this help

Examples:
  cairn project add .
  cairn spec create --title "Offline search" --body-file /tmp/spec.md
  cairn ticket create --parent SPEC-abc12345 --title "Search notes" --body-file /tmp/ticket.md
  cairn next --project cairn

The viewer can edit titles, Markdown and status. Other edits use the CLI. No GitHub Issues are created.
`;

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        json: { type: "boolean" },
        db: { type: "string" },
        project: { type: "string" },
        name: { type: "string" },
        title: { type: "string" },
        "body-file": { type: "string" },
        parent: { type: "string" },
        "blocked-by": { type: "string" },
        label: { type: "string" },
        revision: { type: "string" },
        port: { type: "string" },
        development: { type: "boolean" },
        output: { type: "string" },
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}
const { values, positionals } = parse();
const [command, action, ...args] = positionals;
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const need = (value: string | undefined, field: string) => {
  if (!value) throw new Error(`Missing ${field}. Run cairn --help.`);
  return value;
};
const body = () =>
  readFileSync(
    values["body-file"] === "-" ? 0 : need(values["body-file"], "--body-file"),
    "utf8",
  );
const blockers = () =>
  values["blocked-by"] === undefined
    ? undefined
    : values["blocked-by"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
function arity(count: number) {
  if (args.length !== count)
    throw new Error("Unexpected or missing arguments. Run cairn --help.");
}
function options(allowed: string[]) {
  const extra = Object.keys(values).filter(
    (key) => !["db", "project", "json", "help", ...allowed].includes(key),
  );
  if (extra.length)
    throw new Error(
      `Unsupported options for this command: ${extra.map((k) => `--${k}`).join(", ")}`,
    );
}

if (values.help || !command) {
  console.log(help);
} else {
  let store: Store | undefined;
  let running = false;
  try {
    let result: unknown;
    if (!["serve", "project", "backup", "spec", "ticket", "doc", "comment", "next", "export"].includes(command))
      throw new Error(`Unknown command: ${command}. Run cairn --help.`);
    store = new Store(values.db);
    if (command === "serve") {
      options(["port", "development"]);
      if (action) throw new Error("serve takes no positional arguments.");
      const port = Number(values.port || 4317);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("Port must be between 1 and 65535.");
      const server = serve(store, {
        allowBrowserAnnotations: values.development === true,
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      running = true;
      console.log(`Cairn is ready at http://127.0.0.1:${port}`);
      const shutdown = () =>
        server.close(() => {
          store!.close();
          process.exit(0);
        });
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    } else if (command === "project") {
      if (action === "add") {
        options(["name"]);
        if (args.length > 1)
          throw new Error("Expected at most one repository path.");
        result = store.register(args[0] || process.cwd(), values.name);
      } else if (action === "list") {
        options([]);
        arity(0);
        result = store.projects();
      } else if (action === "resolve") {
        options([]);
        arity(0);
        result = store.resolveProject(values.project);
      } else throw new Error("Expected project add, list, or resolve.");
    } else if (command === "backup") {
      options(["output"]);
      if (action) throw new Error("backup takes no positional arguments.");
      result = await store.backup(need(values.output, "--output"));
    } else {
      const project = store.resolveProject(values.project);
      if (command === "spec" || command === "ticket") {
        arity(0);
        if (action === "create") {
          options(
            command === "spec"
              ? ["title", "body-file", "label"]
              : ["title", "body-file", "parent", "blocked-by", "label"],
          );
          result = store.create(project.id, {
            kind: command as Kind,
            title: need(values.title, "--title"),
            body: body(),
            parent: values.parent,
            blockers: blockers(),
            label: values.label,
          });
        } else if (action === "list") {
          options([]);
          result = store.list(project.id, command as Kind);
        } else throw new Error("Expected create or list.");
      } else if (command === "doc") {
        const id = need(args[0], "document ID");
        if (action === "get") {
          options([]);
          arity(1);
          result = store.get(project.id, id);
        } else if (action === "status") {
          options([]);
          arity(2);
          result = store.status(project.id, id, need(args[1], "status"));
        } else if (action === "update") {
          options(["title", "body-file", "label", "blocked-by", "revision"]);
          arity(1);
          const revision =
            values.revision === undefined ? undefined : Number(values.revision);
          if (
            revision !== undefined &&
            (!Number.isInteger(revision) || revision < 1)
          )
            throw new Error("Revision must be a positive integer.");
          if (
            [
              values.title,
              values["body-file"],
              values.label,
              values["blocked-by"],
            ].every((v) => v === undefined)
          )
            throw new Error("Specify at least one field to update.");
          result = store.update(project.id, id, {
            title: values.title,
            body: values["body-file"] === undefined ? undefined : body(),
            label: values.label,
            blockers: blockers(),
            revision,
          });
        } else if (action === "export") {
          options([]);
          arity(1);
          process.stdout.write(store.get(project.id, id).body);
        } else throw new Error("Expected doc get, update, status, or export.");
      } else if (command === "comment" && action === "add") {
        options(["body-file"]);
        arity(1);
        result = store.comment(
          project.id,
          need(args[0], "document ID"),
          body(),
        );
      } else if (command === "next") {
        options([]);
        if (action) throw new Error("next takes no positional arguments.");
        result = store.next(project.id);
      } else if (command === "export") {
        options(["output"]);
        if (action) throw new Error("export takes no positional arguments.");
        result = store.export(project.id);
        if (values.output) {
          writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          result = { path: values.output };
        }
      } else throw new Error(`Unknown command: ${command}. Run cairn --help.`);
    }
    if (result !== undefined) json(result);
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  } finally {
    if (!running) store?.close();
  }
}
