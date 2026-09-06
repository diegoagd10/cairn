import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { Store } from "./store.ts";

export function markdown(body: string): string {
  return sanitizeHtml(marked.parse(body, { async: false }), {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "input",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      input: ["type", "checked", "disabled"],
      ol: ["start"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noreferrer noopener" }),
      input: (_tag, attrs) => ({
        tagName: "input",
        attribs: {
          type: "checkbox",
          disabled: "",
          ...(Object.hasOwn(attrs, "checked") ? { checked: "" } : {}),
        },
      }),
    },
  });
}

export function serve(store: Store) {
  const assets = new Map([
    ["/", { type: "text/html; charset=utf-8", file: "index.html" }],
    ["/app.js", { type: "text/javascript; charset=utf-8", file: "app.js" }],
    ["/style.css", { type: "text/css; charset=utf-8", file: "style.css" }],
    ["/favicon.svg", { type: "image/svg+xml", file: "favicon.svg" }],
  ]);
  return createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    // Loopback binding plus Host/Origin checks prevents DNS rebinding and cross-origin reads.
    const expectedHost = `127.0.0.1:${(req.socket.address() as { port: number }).port}`;
    if (
      req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
    ) {
      send(403, { error: "Use the local Cairn viewer URL." });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      send(405, {
        error: "The viewer is read-only. Use the Cairn CLI to edit.",
      });
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${expectedHost}`);
      const asset = assets.get(url.pathname);
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type });
        res.end(readFileSync(new URL(`../web/${asset.file}`, import.meta.url)));
        return;
      }
      if (url.pathname === "/api/projects") {
        send(
          200,
          store.projects().map((p) => {
            const docs = store.list(p.id);
            return {
              ...p,
              specs: docs.filter((d) => d.kind === "spec").length,
              tickets: docs.filter((d) => d.kind === "ticket").length,
              done: docs.filter(
                (d) => d.kind === "ticket" && d.status === "done",
              ).length,
            };
          }),
        );
        return;
      }
      const listMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/documents$/,
      );
      if (listMatch) {
        send(
          200,
          store
            .list(decodeURIComponent(listMatch[1]!))
            .map(({ body, comments, ...doc }) => ({
              ...doc,
              excerpt: body.slice(0, 220),
              comment_count: comments.length,
            })),
        );
        return;
      }
      const docMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/,
      );
      if (docMatch) {
        const doc = store.get(
          decodeURIComponent(docMatch[1]!),
          decodeURIComponent(docMatch[2]!),
        );
        send(200, {
          ...doc,
          html: markdown(doc.body),
          comments: doc.comments.map((c) => ({ ...c, html: markdown(c.body) })),
        });
        return;
      }
      send(404, { error: "Not found." });
    } catch (error) {
      send(400, {
        error:
          error instanceof Error ? error.message : "Could not read project.",
      });
    }
  });
}
