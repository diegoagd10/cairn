const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const state = {
  projects: [],
  project: null,
  docs: [],
  selected: null,
  detail: null,
  kind: "spec",
  query: "",
  filter: "all",
};
let generation = 0;
let lastSnapshot = "";
const route = () => new URLSearchParams(location.hash.slice(1));
const href = (project, doc) =>
  `#${new URLSearchParams({ project, ...(doc ? { doc } : {}) })}`;
const statusText = (doc) =>
  doc.status === "todo" && doc.unresolved.length
    ? "Blocked"
    : {
        todo: "To do",
        "in-progress": "In progress",
        done: "Done",
        cancelled: "Cancelled",
      }[doc.status];
const badge = (doc) =>
  `<span class="badge ${doc.status === "todo" && doc.unresolved.length ? "blocked" : escape(doc.status)}">${statusText(doc)}</span>`;
const date = (value) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
const ready = (doc) =>
  doc.kind === "ticket" &&
  doc.status === "todo" &&
  doc.label === "ready-for-agent" &&
  !doc.unresolved.length;
const tickets = (spec) =>
  state.docs.filter((d) => d.kind === "ticket" && d.parent_id === spec.id);
async function api(path) {
  const response = await fetch(path);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Could not load workspace.");
  return value;
}
function showError(error) {
  $("#error").textContent = error.message;
  $("#error").hidden = false;
  $("#connection").textContent = "Connection interrupted";
}
function renderProjects() {
  $("#project-count").textContent = state.projects.length;
  $("#projects").innerHTML = state.projects
    .map(
      (p) =>
        `<a class="project-link ${p.id === state.project?.id ? "active" : ""}" ${p.id === state.project?.id ? 'aria-current="page"' : ""} href="${href(p.id)}"><span class="project-icon" aria-hidden="true">▱</span><span class="project-name">${escape(p.name)}</span><span class="count">${p.tickets}</span></a>`,
    )
    .join("");
}
function renderOverview() {
  $("#breadcrumb").textContent = state.project
    ? `Workspace / ${state.project.name}`
    : "Workspace";
  $("#heading").textContent = state.project
    ? state.project.name
    : "Your path, mapped.";
  $("#subtitle").textContent = state.project
    ? "A clear destination. A thoughtful path to get there."
    : "Specs set the destination. Tickets show the way.";
  const specs = state.docs.filter((d) => d.kind === "spec");
  const allTickets = state.docs.filter((d) => d.kind === "ticket");
  const done = allTickets.filter((d) => d.status === "done").length;
  const blocked = allTickets.filter(
    (d) => d.status === "todo" && d.unresolved.length,
  ).length;
  const stats = [
    ["Specs", specs.length, "Destinations defined"],
    ["Ready to start", allTickets.filter(ready).length, "Your next steps"],
    [
      "In progress",
      allTickets.filter((d) => d.status === "in-progress").length,
      `${blocked} ${blocked === 1 ? "ticket" : "tickets"} blocked`,
    ],
    [
      "Completed",
      `${done}<small>/ ${allTickets.length}</small>`,
      "Steps behind you",
    ],
  ];
  $("#stats").innerHTML = stats
    .map(
      ([label, value, note]) =>
        `<div class="stat"><span class="stat-label">${label}</span><span class="stat-number">${value}</span><div class="stat-bottom">${note}</div></div>`,
    )
    .join("");
  $("#spec-count").textContent = specs.length;
  $("#ticket-count").textContent = allTickets.length;
}
function renderList() {
  for (const button of document.querySelectorAll("[data-kind]")) {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.kind === state.kind),
    );
    button.tabIndex = button.dataset.kind === state.kind ? 0 : -1;
  }
  const docs = state.docs
    .filter((d) => d.kind === state.kind)
    .filter((d) =>
      `${d.title} ${d.id}`.toLowerCase().includes(state.query.toLowerCase()),
    )
    .filter(
      (d) =>
        state.filter === "all" ||
        (state.filter === "ready"
          ? ready(d)
          : state.filter === "blocked"
            ? d.status === "todo" && d.unresolved.length
            : d.status === state.filter),
    );
  if (!docs.length) {
    const filtered = state.query || state.filter !== "all";
    $("#documents").innerHTML =
      `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><h2>${!state.project ? "Every path starts somewhere." : filtered ? "A quieter stretch of trail." : state.kind === "spec" ? "Start with a destination." : "Make room for your next step."}</h2><p>${!state.project ? "Register a repository to give its plans a home." : filtered ? "No documents match your search and filters." : state.kind === "spec" ? "Create a spec with your agent, then explore it here." : "Break a spec into tickets with your agent. They’ll appear here."}</p>${filtered ? '<button class="text-button" id="clear-filters">Clear filters</button>' : `<code>${!state.project ? "cairn project add /path/to/repo" : `cairn ${state.kind} create --title &quot;Your ${state.kind}&quot; --body-file /tmp/${state.kind}.md`}</code>`}</div>`;
    $("#clear-filters")?.addEventListener("click", () => {
      state.query = "";
      state.filter = "all";
      $("#search").value = "";
      $("#status").value = "all";
      renderList();
    });
    return;
  }
  $("#documents").innerHTML = docs
    .map((d) => {
      const children = tickets(d);
      const done = children.filter((t) => t.status === "done").length;
      const summary =
        d.kind === "spec"
          ? `${children.length} ${children.length === 1 ? "ticket" : "tickets"} · ${done} completed`
          : d.unresolved.length
            ? `${d.unresolved.length} unfinished ${d.unresolved.length === 1 ? "blocker" : "blockers"}`
            : ready(d)
              ? "Ready for your next session"
              : d.parent_id || "Standalone ticket";
      const plain = d.excerpt
        .replace(/[#*`>\[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return `<button class="document-card ${d.id === state.selected ? "selected" : ""}" data-document="${escape(d.id)}" aria-label="${escape(d.title)}"><div class="card-top"><span class="doc-id">${escape(d.id)}</span>${badge(d)}</div><h3 class="card-title">${escape(d.title)}</h3><p class="card-excerpt">${escape(plain)}</p><div class="card-bottom"><span>${escape(summary)}</span><span>${date(d.updated_at)} <span class="arrow" aria-hidden="true">↗</span></span></div>${children.length ? `<div class="progress-track"><progress value="${done}" max="${children.length}" aria-label="Completed tickets"></progress></div>` : ""}</button>`;
    })
    .join("");
  for (const button of document.querySelectorAll("[data-document]"))
    button.addEventListener("click", () => {
      location.hash = href(state.project.id, button.dataset.document);
    });
}
function related(ids) {
  return ids
    .map((id) => {
      const doc = state.docs.find((d) => d.id === id);
      return doc
        ? `<button class="related" data-related="${escape(id)}"><span>${escape(doc.title)}</span>${badge(doc)}</button>`
        : "";
    })
    .join("");
}
function renderDetail() {
  const panel = $("#detail");
  if (!state.detail) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const d = state.detail;
  const scroll = panel.scrollTop;
  panel.hidden = false;
  panel.innerHTML = `<div class="detail-toolbar"><button class="text-button" id="close-detail">← Back to list</button><button class="text-button" id="download">↓ Markdown</button></div><span class="doc-id">${escape(d.id)}</span><h2>${escape(d.title)}</h2><div class="detail-meta">${badge(d)}<span>${escape(d.label)}</span><span>Updated ${date(d.updated_at)}</span></div>${d.parent_id ? `<div class="detail-label">Destination</div>${related([d.parent_id])}` : ""}${d.blockers.length ? `<div class="detail-label">Depends on</div>${related(d.blockers)}` : ""}<article class="markdown">${d.html}</article>${d.kind === "spec" && tickets(d).length ? `<div class="detail-label">The path · ${tickets(d).length} tickets</div>${related(tickets(d).map((t) => t.id))}` : ""}${d.comments.length ? `<div class="detail-label">Notes · ${d.comments.length}</div>${d.comments.map((c) => `<div class="comment"><small>${date(c.created_at)}</small><div class="markdown">${c.html}</div></div>`).join("")}` : ""}`;
  panel.scrollTop = scroll;
  $("#close-detail").addEventListener("click", closeDetail);
  $("#download").addEventListener("click", () => {
    const url = URL.createObjectURL(
      new Blob([d.body], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${d.id}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  for (const button of panel.querySelectorAll("[data-related]"))
    button.addEventListener("click", () => {
      location.hash = href(state.project.id, button.dataset.related);
    });
}
function closeDetail() {
  location.hash = href(state.project.id);
}
async function load({ focus = false } = {}) {
  const request = ++generation;
  try {
    const params = route();
    const projects = await api("/api/projects");
    const project =
      projects.find((p) => p.id === params.get("project")) ||
      (!params.has("project") ? projects[0] : null);
    if (params.has("project") && !project)
      throw new Error(
        "This repository is unavailable. Choose one from the sidebar.",
      );
    const docs = project
      ? await api(`/api/projects/${project.id}/documents`)
      : [];
    const selected = params.get("doc");
    const detail =
      project && selected
        ? await api(
            `/api/projects/${project.id}/documents/${encodeURIComponent(selected)}`,
          )
        : null;
    if (request !== generation) return;
    $("#error").hidden = true;
    $("#connection").textContent = "Up to date · local";
    const snapshot = JSON.stringify({
      projects,
      project,
      docs,
      selected,
      detail,
    });
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    const changedProject = state.project?.id !== project?.id;
    const changedDocument = state.selected !== selected;
    if (changedProject) {
      state.query = "";
      state.filter = "all";
      $("#search").value = "";
      $("#status").value = "all";
    }
    Object.assign(state, { projects, project, docs, selected, detail });
    if (detail && (changedDocument || changedProject)) state.kind = detail.kind;
    renderProjects();
    renderOverview();
    renderList();
    renderDetail();
    if (focus && changedDocument) {
      if (detail) {
        $("#detail").scrollTop = 0;
        $("#close-detail").focus();
      } else document.querySelector(".document-card")?.focus();
    }
  } catch (error) {
    if (request === generation) showError(error);
  }
}
for (const button of document.querySelectorAll("[data-kind]")) {
  button.addEventListener("click", () => {
    state.kind = button.dataset.kind;
    renderList();
  });
  button.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const next =
        button.dataset.kind === "spec" ? $("#tab-ticket") : $("#tab-spec");
      next.click();
      next.focus();
    }
  });
}
$("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderList();
});
$("#status").addEventListener("change", (event) => {
  state.filter = event.target.value;
  renderList();
});
$("#refresh").addEventListener("click", () => load());
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  ) {
    event.preventDefault();
    $("#search").focus();
  }
  if (event.key === "Escape" && state.detail) closeDetail();
});
window.addEventListener("hashchange", () => load({ focus: true }));
await load();
setInterval(() => {
  if (!document.hidden && !$("#detail").contains(document.activeElement))
    load();
}, 15000);
