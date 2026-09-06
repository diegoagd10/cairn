const $ = (selector) => document.querySelector(selector);
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
let preferredTheme;
try {
  const savedTheme = localStorage.getItem("cairn-theme");
  if (["light", "dark"].includes(savedTheme)) preferredTheme = savedTheme;
} catch {
  // Theme switching still works when browser storage is unavailable.
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
  $("#theme-toggle").setAttribute("aria-label", label);
  $("#theme-toggle").title = label;
  $("meta[name=theme-color]").content =
    theme === "dark" ? "#17231e" : "#25483d";
}
applyTheme(preferredTheme || (systemTheme.matches ? "dark" : "light"));
$("#theme-toggle").addEventListener("click", () => {
  preferredTheme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(preferredTheme);
  try {
    localStorage.setItem("cairn-theme", preferredTheme);
  } catch {
    // Keep the selected theme for this page even if it cannot be saved.
  }
});
systemTheme.addEventListener("change", (event) => {
  if (!preferredTheme) applyTheme(event.matches ? "dark" : "light");
});
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const defaultStatus = "ready-for-agent";
const state = {
  projects: [],
  project: null,
  docs: [],
  selected: null,
  detail: null,
  kind: "spec",
  query: "",
  filter: defaultStatus,
  savingStatus: false,
  savingEdit: false,
};
// Keep drafts across in-app navigation; polling must never replace typed text.
const drafts = new Map();
const draftKey = (project, doc) => `${project}/${doc}`;
let generation = 0;
let lastSnapshot = "";
const route = () => new URLSearchParams(location.hash.slice(1));
const href = (project, doc) =>
  `#${new URLSearchParams({ project, ...(doc ? { doc } : {}) })}`;
const statusText = (doc) =>
  doc.status === "done" ? "Done" : "Ready for agent";
const badge = (doc) =>
  `<span class="badge ${escape(doc.status)}">${statusText(doc)}</span>`;
const date = (value) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(value),
  );
const ready = (doc) =>
  doc.kind === "ticket" &&
  doc.status === "ready-for-agent" &&
  !doc.unresolved.length;
const tickets = (spec) =>
  state.docs.filter((d) => d.kind === "ticket" && d.parent_id === spec.id);
async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || "Could not load workspace.");
    error.status = response.status;
    throw error;
  }
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
    (d) => d.status === "ready-for-agent" && d.unresolved.length,
  ).length;
  const stats = [
    ["Specs", specs.length, "Destinations defined"],
    ["Ready to start", allTickets.filter(ready).length, "Your next steps"],
    ["Waiting on dependencies", blocked, "Finish their blockers first"],
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
    .filter((d) => state.filter === "all" || d.status === state.filter);
  if (!docs.length) {
    const filtered = state.query || state.filter !== "all";
    const filterAction =
      state.query || state.filter !== defaultStatus
        ? '<button class="text-button" id="clear-filters">Reset filters</button>'
        : '<p>Choose Done or All statuses in the Status dropdown to view completed documents.</p>';
    $("#documents").innerHTML =
      `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><h2>${!state.project ? "Every path starts somewhere." : filtered ? "A quieter stretch of trail." : state.kind === "spec" ? "Start with a destination." : "Make room for your next step."}</h2><p>${!state.project ? "Register a repository to give its plans a home." : filtered ? "No documents match your search and filters." : state.kind === "spec" ? "Create a spec with your agent, then explore it here." : "Break a spec into tickets with your agent. They’ll appear here."}</p>${filtered && state.project ? filterAction : `<code>${!state.project ? "cairn project add /path/to/repo" : `cairn ${state.kind} create --title &quot;Your ${state.kind}&quot; --body-file /tmp/${state.kind}.md`}</code>`}</div>`;
    $("#clear-filters")?.addEventListener("click", () => {
      state.query = "";
      state.filter = defaultStatus;
      $("#search").value = "";
      $("#status").value = defaultStatus;
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
function renderEditor(draft, key) {
  const panel = $("#detail");
  panel.hidden = false;
  // Background refreshes may update the list, but leave this editor intact.
  if (panel.querySelector("#document-editor")?.dataset.key === key) return;
  panel.innerHTML = `<div class="detail-toolbar"><button class="text-button" id="close-detail">← Back to list</button><span class="status-note">Draft · not saved</span></div>
    <span class="doc-id">${escape(draft.id)}</span><h2>Edit ${escape(draft.kind)}</h2>
    <form id="document-editor">
      <label for="edit-title">Title</label>
      <input id="edit-title" name="title" required />
      <label for="edit-body">Markdown</label>
      <textarea id="edit-body" name="body" rows="18" required spellcheck="false"></textarea>
      <p id="edit-error" role="alert" hidden></p>
      <details id="latest-version" hidden open><summary>Latest saved version</summary><h3 id="latest-title"></h3><pre id="latest-body"></pre></details>
      <div class="editor-actions"><button type="submit" id="save-document" class="status-button">Save changes</button><button type="button" id="cancel-edit" class="text-button">Cancel</button></div>
    </form>`;
  const showDraftFeedback = () => {
    $("#edit-error").textContent = draft.error || "";
    $("#edit-error").hidden = !draft.error;
    $("#latest-version").hidden = !draft.latest;
    $("#latest-title").textContent = draft.latest?.title || "";
    $("#latest-body").textContent = draft.latest?.body || "";
  };
  showDraftFeedback();
  const form = $("#document-editor");
  form.dataset.key = key;
  $("#edit-title").value = draft.title;
  $("#edit-body").value = draft.body;
  for (const field of ["title", "body"])
    $(`#edit-${field}`).addEventListener("input", (event) => {
      draft[field] = event.target.value;
    });
  $("#close-detail").addEventListener("click", closeDetail);
  $("#cancel-edit").addEventListener("click", async () => {
    drafts.delete(key);
    renderDetail();
    lastSnapshot = "";
    await load();
    $("#edit-document")?.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.savingEdit) return;
    if (!draft.title.trim() || !draft.body.trim()) {
      $("#edit-error").textContent = "Title and Markdown must not be empty.";
      $("#edit-error").hidden = false;
      return;
    }
    state.savingEdit = true;
    ++generation;
    const controls = form.querySelectorAll("input, textarea, button");
    for (const control of controls) control.disabled = true;
    const button = $("#save-document");
    button.textContent = "Saving…";
    $("#edit-error").hidden = true;
    const endpoint = `/api/projects/${encodeURIComponent(draft.project_id)}/documents/${encodeURIComponent(draft.id)}`;
    let saved = false;
    try {
      const updated = await api(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cairn-Request": "edit",
        },
        body: JSON.stringify({
          title: draft.title,
          body: draft.body,
          revision: draft.revision,
        }),
      });
      drafts.delete(key);
      if (
        state.detail?.id === draft.id &&
        state.project?.id === draft.project_id
      ) {
        state.detail = updated;
        state.docs = state.docs.map((doc) =>
          doc.id === draft.id
            ? { ...doc, ...updated, excerpt: updated.body.slice(0, 220) }
            : doc,
        );
        renderList();
        renderDetail();
      }
      saved = true;
    } catch (error) {
      let message = error.message;
      if (error.status === 409) {
        try {
          const latest = await api(endpoint);
          draft.latest = latest;
          draft.revision = latest.revision;
          message = "This document changed elsewhere. Your draft is preserved. Review the latest saved version below before saving your changes again.";
        } catch {
          message += " Your draft is preserved. Try saving again when the connection returns.";
        }
      }
      draft.error = message;
      showDraftFeedback();
    } finally {
      state.savingEdit = false;
      for (const control of controls) control.disabled = false;
      button.textContent = "Save changes";
    }
    if (saved) lastSnapshot = "";
    await load();
    if (
      saved &&
      $("#status-feedback") &&
      route().get("doc") === draft.id &&
      state.project?.id === draft.project_id
    ) {
      $("#status-feedback").textContent = "Changes saved.";
      $("#status-feedback").hidden = false;
      $("#edit-document").focus();
    }
  });
}
function renderDetail() {
  const panel = $("#detail");
  $(".list-pane").hidden = Boolean(state.detail);
  if (!state.detail) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const d = state.detail;
  const key = draftKey(d.project_id, d.id);
  if (drafts.has(key)) {
    renderEditor(drafts.get(key), key);
    return;
  }
  const scroll = panel.scrollTop;
  panel.hidden = false;
  panel.innerHTML = `<div class="detail-toolbar"><button class="text-button" id="close-detail">← Back to list</button><div class="detail-actions"><button class="text-button" id="edit-document">Edit</button><button class="text-button" id="download">↓ Markdown</button></div></div><span class="doc-id">${escape(d.id)}</span><h2>${escape(d.title)}</h2><div class="detail-meta">${badge(d)}<span>Updated ${date(d.updated_at)}</span></div><div class="status-controls"><button id="change-status" class="status-button">${d.status === "done" ? "Mark ready for agent" : "Mark as done"}</button><p id="status-feedback" role="status" hidden></p><p id="status-error" role="alert" hidden></p>${d.unresolved.length ? '<p class="status-note">Finish the dependencies below before marking this ticket done.</p>' : d.kind === "spec" && tickets(d).some((t) => t.status !== "done") ? '<p class="status-note">Finish all tickets in this spec before marking it done.</p>' : ""}</div>${d.parent_id ? `<div class="detail-label">Destination</div>${related([d.parent_id])}` : ""}${d.blockers.length ? `<div class="detail-label">Depends on</div>${related(d.blockers)}` : ""}<article class="markdown">${d.html}</article>${d.kind === "spec" && tickets(d).length ? `<div class="detail-label">The path · ${tickets(d).length} tickets</div>${related(tickets(d).map((t) => t.id))}` : ""}${d.comments.length ? `<div class="detail-label">Notes · ${d.comments.length}</div>${d.comments.map((c) => `<div class="comment"><small>${date(c.created_at)}</small><div class="markdown">${c.html}</div></div>`).join("")}` : ""}`;
  panel.scrollTop = scroll;
  $("#close-detail").addEventListener("click", closeDetail);
  $("#edit-document").addEventListener("click", () => {
    if (state.savingStatus) return;
    drafts.set(key, { ...d });
    renderDetail();
    $("#edit-title").focus();
  });
  $("#change-status").addEventListener("click", async (event) => {
    if (state.savingStatus) return;
    state.savingStatus = true;
    ++generation; // Discard reads that started before this write.
    const projectId = state.project.id;
    const button = event.currentTarget;
    const text = button.textContent;
    button.disabled = true;
    button.textContent = "Saving…";
    $("#status-error").hidden = true;
    $("#status-feedback").hidden = true;
    let failure;
    try {
      await api(
        `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(d.id)}/status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cairn-Request": "status",
          },
          body: JSON.stringify({
            status: d.status === "done" ? "ready-for-agent" : "done",
            revision: d.revision,
          }),
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      state.savingStatus = false;
      button.disabled = false;
      button.textContent = text;
    }
    lastSnapshot = "";
    await load();
    if (route().get("doc") === d.id && state.project?.id === projectId) {
      const feedback = $(failure ? "#status-error" : "#status-feedback");
      if (feedback) {
        feedback.textContent = failure ? failure.message : "Status updated.";
        feedback.hidden = false;
      }
      $("#change-status")?.focus();
    }
  });
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
function setSidebarOpen(open) {
  const sidebar = $("#sidebar");
  const toggle = $("#sidebar-toggle");
  if (!open && sidebar.contains(document.activeElement)) toggle.focus();
  sidebar.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute(
    "aria-label",
    open ? "Hide repositories" : "Show repositories",
  );
  toggle.title = open ? "Hide repositories" : "Show repositories";
}
$("#sidebar-toggle").addEventListener("click", () => {
  setSidebarOpen($("#sidebar").hidden);
});
$("#sidebar").addEventListener("click", (event) => {
  if (event.target.closest("a") && window.matchMedia("(max-width: 800px)").matches)
    setSidebarOpen(false);
});
async function load({ focus = false } = {}) {
  if (state.savingStatus || state.savingEdit) return;
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
      state.filter = defaultStatus;
      $("#search").value = "";
      $("#status").value = defaultStatus;
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
    !state.detail &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  ) {
    event.preventDefault();
    $("#search").focus();
  }
  if (event.key === "Escape") {
    if (!$("#sidebar").hidden) setSidebarOpen(false);
    else if (state.detail) closeDetail();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (drafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("hashchange", () => load({ focus: true }));
await load();
setInterval(() => {
  if (!document.hidden && !$("#detail").contains(document.activeElement))
    load();
}, 15000);
