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

export function serve(
  store: Store,
  options: { allowBrowserAnnotations?: boolean } = {},
) {
  const assets = new Map([
    ["/", { type: "text/html; charset=utf-8", file: "index.html" }],
    ["/app.js", { type: "text/javascript; charset=utf-8", file: "app.js" }],
    ["/style.css", { type: "text/css; charset=utf-8", file: "style.css" }],
    ["/favicon.svg", { type: "image/svg+xml", file: "favicon.svg" }],
  ]);
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'${options.allowBrowserAnnotations ? " 'unsafe-inline'" : ""}; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    // Loopback binding plus Host/Origin checks prevent DNS rebinding. Document
    // writes additionally require a same-origin JSON request from our client.
    const expectedHost = `127.0.0.1:${(req.socket.address() as { port: number }).port}`;
    if (
      req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)
    ) {
      send(403, { error: "Use the local Cairn viewer URL." });
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${expectedHost}`);
      const statusMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/documents\/([^/]+)\/status$/,
      );
      const docMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/documents\/([^/]+)$/,
      );
      const writeMatch = statusMatch || docMatch;
      const action = statusMatch ? "status" : "edit";
      const limit = statusMatch ? 4096 : 1024 * 1024;
      if (req.method === "POST" && writeMatch) {
        if (
          req.headers.origin !== `http://${expectedHost}` ||
          req.headers["x-cairn-request"] !== action ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        ) {
          send(403, {
            error: "Document changes must come from the local Cairn UI.",
          });
          return;
        }
        if (
          req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        ) {
          send(415, { error: "Expected application/json." });
          return;
        }
        if (Number(req.headers["content-length"]) > limit) {
          send(413, { error: "Document request is too large." });
          req.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) {
            send(413, { error: "Document request is too large." });
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).some(
            (key) =>
              !(statusMatch
                ? ["status", "revision"]
                : ["title", "body", "revision"]
              ).includes(key),
          ) ||
          (statusMatch
            ? typeof body.status !== "string"
            : typeof body.title !== "string" || typeof body.body !== "string") ||
          !Number.isSafeInteger(body.revision) ||
          body.revision < 1
        ) {
          send(400, {
            error: statusMatch
              ? "Expected a status and a positive document revision."
              : "Expected a title, Markdown body and a positive document revision.",
          });
          return;
        }
        const projectId = decodeURIComponent(writeMatch[1]!);
        const documentId = decodeURIComponent(writeMatch[2]!);
        const doc = statusMatch
          ? store.status(projectId, documentId, body.status, body.revision)
          : store.update(projectId, documentId, {
              title: body.title,
              body: body.body,
              revision: body.revision,
            });
        send(
          200,
          statusMatch ? doc : {
            ...doc,
            html: markdown(doc.body),
            comments: doc.comments.map((c) => ({ ...c, html: markdown(c.body) })),
          },
        );
        return;
      }
      if (req.method !== "GET") {
        res.setHeader(
          "Allow",
          statusMatch ? "POST" : docMatch ? "GET, POST" : "GET",
        );
        send(405, {
          error:
            "Use GET to read documents or POST to edit their content or status.",
        });
        return;
      }
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
      send(
        error instanceof Error && error.message.startsWith("Revision conflict")
          ? 409
          : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not update workspace.",
        },
      );
    }
  });
}
