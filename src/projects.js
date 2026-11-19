"use strict";
/**
 * Event projects: the task board behind each WMF event.
 * Every event has a Project tab with its tasks (owner, team, due date, status, progress), and each task has
 * comments and files. The WMF team shares an event's project with another department by link (/pj/<token>):
 * a "contribute" link lets that department add tasks, move them, comment and upload; a "view" link only shows the board.
 * The board is the same page for staff and for a shared link; only the base address and the rights differ.
 */
const crypto = require("crypto");
const multer = require("multer");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate } = require("./views");

const STATUS = [["todo", "To do"], ["doing", "In progress"], ["review", "Needs review"], ["done", "Done"]];
const ST = Object.fromEntries(STATUS);
const TEAMS = ["WMF", "Marketing", "Operations", "Partnerships", "Finance", "Media", "Procurement", "Corporate"];
const PRIORITY = ["Normal", "High"];
const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024;
const FILE_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-(excel|powerpoint)))$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 20 } });
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const DAY = 864e5;
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

// ---------- small view pieces ----------
const AV = ["#4a5bc4", "#d86a57", "#2a9d7c", "#8b2622", "#b07d12", "#6b4fb8", "#1b7259", "#c0567a"];
function initials(name) {
  const p = R.clean(name).split(" ").filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function avatar(name, size = "") {
  if (!name) return `<span class="pj-av none ${size}" title="No owner yet" aria-hidden="true">?</span>`;
  let n = 0; for (const c of String(name)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="pj-av ${size}" style="background:${AV[n % AV.length]}" title="${h(name)}" aria-hidden="true">${h(initials(name))}</span>`;
}
function dueChip(t, today) {
  if (!t.due_date) return `<span class="pj-due none">No date</span>`;
  const d = dayDiff(today, t.due_date), lbl = fmtDate(t.due_date).replace(/ \d{4}$/, "");
  if (t.status === "done") return `<span class="pj-due done">${lbl}</span>`;
  if (d < 0) return `<span class="pj-due late" title="Overdue">${-d}d late</span>`;
  if (d === 0) return `<span class="pj-due soon">Today</span>`;
  if (d <= 3) return `<span class="pj-due soon">${d === 1 ? "Tomorrow" : lbl}</span>`;
  return `<span class="pj-due">${lbl}</span>`;
}
const bar = (pct, cls = "") => `<span class="pj-bar ${cls}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><i style="width:${pct}%"></i></span>`;
const ico = {
  chat: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  clip: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  share: `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="12" cy="3.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="4" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.8 7 4.4-2.4M5.8 9l4.4 2.4" stroke="currentColor" stroke-width="1.4"/></svg>`,
  file: `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
};
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const ago = (d) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
  return new Date(d).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" });
};

/** Overall figures for one event's tasks. */
function summary(tasks, today) {
  const open = tasks.filter((t) => t.status !== "done");
  return {
    total: tasks.length, done: tasks.length - open.length,
    pct: tasks.length ? Math.round(tasks.reduce((s, t) => s + (t.status === "done" ? 100 : t.progress), 0) / tasks.length) : 0,
    late: open.filter((t) => t.due_date && t.due_date < today).length,
    week: open.filter((t) => t.due_date && t.due_date >= today && dayDiff(today, t.due_date) <= 7).length,
    review: tasks.filter((t) => t.status === "review").length,
    teams: [...new Set(tasks.map((t) => t.team).filter(Boolean))],
  };
}

/** The tab row shown on every staff page of one event: Details, Sign-ups, Project. */
function eventTabs(a, on, counts = {}) {
  const id = encodeURIComponent(a.activity_id);
  const today = R.todayLocal(), d = a.event_date ? dayDiff(today, a.event_date) : null;
  const when = d == null ? "" : d > 1 ? `In ${d} days` : d === 1 ? "Tomorrow" : d === 0 ? "Today" : "Held";
  const tab = (href, key, label, n) => `<a href="${href}" ${on === key ? 'aria-current="page"' : ""}>${label}${n != null ? ` <span class="pj-n">${n}</span>` : ""}</a>`;
  return `<section class="card ev-head"><div class="ev-title"><p class="ev-eyebrow">WMF event${a.event_date ? " · " + fmtDate(a.event_date) : ""}${a.location ? " · " + h(a.location) : ""}</p>
      <h2>${h(a.name)}</h2></div>${when ? `<span class="ev-when ${d != null && d >= 0 && d <= 14 ? "soon" : ""}">${when}</span>` : ""}
    <nav class="ev-tabs" aria-label="Event">${tab(`/activities/${id}/project`, "project", "Project", counts.tasks)}${tab(`/activities/${id}/signups`, "signups", "Sign-ups", counts.signups)}${tab(`/activities/${id}`, "details", "Details")}</nav></section>`;
}

async function tasksOf(activityId) {
  return (await pool.query(`SELECT t.*, (SELECT count(*)::int FROM project_notes n WHERE n.task_id = t.id AND n.kind = 'comment') AS comments,
      (SELECT count(*)::int FROM project_files f WHERE f.task_id = t.id) AS files
    FROM project_tasks t WHERE t.activity_id = $1 ORDER BY (t.status = 'done'), t.due_date NULLS LAST, t.priority = 'Normal', t.id`, [activityId])).rows;
}
/** One line per event for the events list: tasks done / total and the average progress. */
async function progressByEvent() {
  const r = await pool.query(`SELECT activity_id, count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS done,
      round(avg(CASE WHEN status = 'done' THEN 100 ELSE progress END))::int AS pct,
      count(*) FILTER (WHERE status <> 'done' AND due_date < (now() AT TIME ZONE 'Asia/Dubai')::date)::int AS late
    FROM project_tasks GROUP BY activity_id`);
  return Object.fromEntries(r.rows.map((x) => [x.activity_id, x]));
}

module.exports = function projects(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const STAFF = need("admin", "coordinator");

  // ---------- who is looking: staff (signed in) or a department through its link ----------
  async function linkOf(token) {
    return (await pool.query(`SELECT l.*, a.name AS event_name FROM project_links l JOIN activities a ON a.activity_id = l.activity_id
      WHERE l.token = $1 AND l.active`, [String(token || "").slice(0, 60)])).rows[0] || null;
  }
  async function ctxOf(req) {
    if (req.params.token) {
      const l = await linkOf(req.params.token);
      if (!l) return null;
      const ev = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [l.activity_id])).rows[0];
      const name = (req.session.pjNames || {})[l.token] || "";
      return { ev, link: l, shared: true, canEdit: l.can_edit, staff: false, base: "/pj/" + encodeURIComponent(l.token), name,
        who: name ? `${name} (${l.team})` : l.team };
    }
    const ev = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [req.params.id])).rows[0];
    if (!ev || ev.kind !== "event") return null;
    const u = user(req);
    return { ev, shared: false, canEdit: true, staff: true, base: `/activities/${encodeURIComponent(ev.activity_id)}/project`, name: u.name || u.email, who: u.name || actor(req) };
  }
  // a department member signs their comments with their name, remembered for this link
  function rememberName(req, c, b) {
    if (!c.shared) return;
    const n = R.clean(b.your_name).slice(0, 60);
    if (!n) return;
    req.session.pjNames = { ...(req.session.pjNames || {}), [c.link.token]: n };
    c.name = n; c.who = `${n} (${c.link.team})`;
  }
  const gone = (req, res) => res.status(404).send(page(req, "Project", `<section class="card"><h2>This link is switched off</h2><p class="lead">Ask the WMF team for a new one.</p></section>`, { wide: false }));
  const out = (req, c, title, body) => page(req, title, body, { active: c.shared ? "/wmf" : "/activities", scripts: `<script src="/project.js"></script>` });

  async function taskOf(c, tid) {
    return (await pool.query("SELECT * FROM project_tasks WHERE id = $1 AND activity_id = $2", [+tid || 0, c.ev.activity_id])).rows[0] || null;
  }
  async function namesFor(activityId) {
    const r = await pool.query(`SELECT DISTINCT owner AS n FROM project_tasks WHERE owner IS NOT NULL
      UNION SELECT DISTINCT name FROM users WHERE active AND name <> '' ORDER BY 1 LIMIT 200`);
    return r.rows.map((x) => x.n);
  }
  const lists = (names) => `<datalist id="pjOwners">${names.map((n) => `<option value="${h(n)}">`).join("")}</datalist>
    <datalist id="pjTeams">${TEAMS.map((n) => `<option value="${h(n)}">`).join("")}</datalist>`;

  // ---------- header for a shared link ----------
  function sharedHead(c, s) {
    const ev = c.ev, today = R.todayLocal(), d = ev.event_date ? dayDiff(today, ev.event_date) : null;
    return `<section class="card ev-head shared"><div class="ev-title"><p class="ev-eyebrow">WMF event${ev.event_date ? " · " + fmtDate(ev.event_date) : ""}${ev.location ? " · " + h(ev.location) : ""}</p>
        <h2>${h(ev.name)}</h2></div>${d != null && d >= 0 ? `<span class="ev-when ${d <= 14 ? "soon" : ""}">${d > 1 ? `In ${d} days` : d === 1 ? "Tomorrow" : "Today"}</span>` : ""}
      <p class="pj-sharednote"><span class="pj-team">${h(c.link.team)}</span> ${c.canEdit ? "You can add tasks, move them, comment and upload files." : "You can follow the tasks. This link is view only."}
        ${c.canEdit && !c.name ? "" : c.name ? ` · Signed as <b>${h(c.name)}</b>` : ""}</p></section>`;
  }

  // ---------- the board ----------
  function overview(c, s, view, team) {
    const q = (o) => { const p = new URLSearchParams({ ...(view === "list" ? { view } : {}), ...(team ? { team } : {}), ...o }); for (const [k, v] of [...p]) if (!v) p.delete(k); const t = p.toString(); return c.base + (t ? "?" + t : ""); };
    return `<section class="card pj-over">
      <div class="pj-ring" style="--p:${s.pct}"><span><b>${s.pct}%</b><small>complete</small></span></div>
      <div class="pj-over-main">
        <p class="pj-over-line"><b>${s.done} of ${s.total}</b> tasks done${s.teams.length ? ` · ${s.teams.length} team${s.teams.length > 1 ? "s" : ""} involved` : ""}</p>
        <div class="pj-stats">
          <span class="pj-stat ${s.late ? "crit" : ""}"><b>${s.late}</b> overdue</span>
          <span class="pj-stat ${s.week ? "warn" : ""}"><b>${s.week}</b> due this week</span>
          <span class="pj-stat"><b>${s.review}</b> to review</span>
        </div>
        ${s.teams.length > 1 ? `<div class="pj-filter" role="group" aria-label="Filter by team"><a href="${q({ team: "" })}" class="${team ? "" : "on"}">All teams</a>${s.teams.map((t) => `<a href="${q({ team: t })}" class="${team === t ? "on" : ""}">${h(t)}</a>`).join("")}</div>` : ""}
      </div>
      <div class="pj-actions">
        <div class="seg" role="group" aria-label="View"><a href="${q({ view: "" })}" class="${view === "list" ? "" : "on"}">Board</a><a href="${q({ view: "list" })}" class="${view === "list" ? "on" : ""}">List</a></div>
        ${c.staff ? `<a class="btn" href="${c.base}/share">${ico.share} Share</a>` : ""}
        ${c.canEdit ? `<button class="btn primary" type="button" data-pj-new>+ New task</button>` : ""}
      </div></section>`;
  }
  function newTaskForm(c, names, status = "todo") {
    return `<section class="card pj-new" id="pjNew" hidden><div class="card-head"><h2>New task</h2><button class="btn ghost" type="button" data-pj-new>Close</button></div>
      <form class="form pj-newform" method="post" action="${c.base}/tasks">
        <label class="pj-wide">What needs doing?<input name="title" required maxlength="140" placeholder="e.g. Book the photographer" autocomplete="off"></label>
        <label>Owner<input name="owner" list="pjOwners" maxlength="60" placeholder="Name" value="${c.shared ? h(c.name) : ""}"></label>
        <label>Team<input name="team" list="pjTeams" maxlength="40" value="${c.shared ? h(c.link.team) : "WMF"}"></label>
        <label>Due date<input type="date" name="due_date"></label>
        <label>Status<select name="status">${STATUS.map(([k, l]) => `<option value="${k}" ${k === status ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="pj-wide">Details <span class="hint">(optional)</span><textarea name="notes" rows="2" maxlength="2000"></textarea></label>
        ${c.shared && !c.name ? `<label>Your name<input name="your_name" required maxlength="60"></label>` : ""}
        <div class="pj-wide"><button class="btn primary">Add task</button></div>
      </form>${lists(names)}</section>`;
  }
  function card(c, t, today) {
    const pct = t.status === "done" ? 100 : t.progress;
    return `<article class="pj-card ${t.status === "done" ? "is-done" : ""}" ${c.canEdit ? `draggable="true"` : ""} data-id="${t.id}">
      <a class="pj-card-link" href="${c.base}/t/${t.id}"><span class="pj-card-top">${t.team ? `<span class="pj-team">${h(t.team)}</span>` : ""}${t.priority === "High" ? `<span class="pj-high">High</span>` : ""}</span>
        <span class="pj-card-title">${h(t.title)}</span></a>
      ${t.status !== "todo" && t.status !== "done" ? `<span class="pj-card-prog">${bar(pct)}<small>${pct}%</small></span>` : ""}
      <span class="pj-card-foot">${avatar(t.owner)}<span class="pj-owner">${h(t.owner || "Unassigned")}</span>
        <span class="pj-meta">${t.comments ? `<span title="${t.comments} comments">${ico.chat}${t.comments}</span>` : ""}${t.files ? `<span title="${t.files} files">${ico.clip}${t.files}</span>` : ""}${dueChip(t, today)}</span></span>
      ${c.canEdit ? `<form class="pj-move" method="post" action="${c.base}/t/${t.id}/move"><select name="status" aria-label="Move ${h(t.title)}" data-autosubmit>${STATUS.map(([k, l]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${l}</option>`).join("")}</select></form>` : ""}
    </article>`;
  }
  function board(c, tasks, today) {
    return `<div class="pj-board" ${c.canEdit ? `data-pj-board="${h(c.base)}"` : ""}>${STATUS.map(([k, l]) => {
      const col = tasks.filter((t) => t.status === k);
      return `<section class="pj-col" data-status="${k}" aria-label="${l}"><header class="pj-col-head"><i class="dot ${k}"></i><h3>${l}</h3><span class="pj-n">${col.length}</span></header>
        <div class="pj-drop">${col.map((t) => card(c, t, today)).join("")}<p class="pj-empty">${k === "todo" ? "Nothing waiting." : "Drop a task here"}</p></div>
        ${c.canEdit && k === "todo" ? `<button class="pj-add" type="button" data-pj-new>+ Add task</button>` : ""}</section>`;
    }).join("")}</div>`;
  }
  function list(c, tasks, today) {
    return `<section class="card pj-list"><div class="tw"><table><thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Status</th><th>Progress</th></tr></thead><tbody>
      ${STATUS.map(([k, l]) => { const g = tasks.filter((t) => t.status === k); return g.length ? `<tr class="pj-grp"><td colspan="5"><i class="dot ${k}"></i>${l} <span class="pj-n">${g.length}</span></td></tr>` + g.map((t) => {
        const pct = t.status === "done" ? 100 : t.progress;
        return `<tr><td><a href="${c.base}/t/${t.id}"><b>${h(t.title)}</b></a>${t.team ? ` <span class="pj-team">${h(t.team)}</span>` : ""}</td>
          <td><span class="pj-who">${avatar(t.owner, "sm")}${h(t.owner || "Unassigned")}</span></td><td>${dueChip(t, today)}</td>
          <td>${c.canEdit ? `<form method="post" action="${c.base}/t/${t.id}/move" style="margin:0"><select class="pj-chip ${t.status}" name="status" data-autosubmit aria-label="Status">${STATUS.map(([s, sl]) => `<option value="${s}" ${s === t.status ? "selected" : ""}>${sl}</option>`).join("")}</select></form>` : `<span class="pj-chip ${t.status}">${ST[t.status]}</span>`}</td>
          <td class="pj-pcell">${bar(pct)}<small>${pct}%</small></td></tr>`;
      }).join("") : ""; }).join("") || `<tr><td colspan="5" class="muted">No tasks yet.</td></tr>`}</tbody></table></div></section>`;
  }
  async function recent(c) {
    const r = await pool.query(`SELECT n.*, t.title FROM project_notes n JOIN project_tasks t ON t.id = n.task_id WHERE t.activity_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 6`, [c.ev.activity_id]);
    if (!r.rows.length) return "";
    return `<section class="card pj-feed"><h2>Latest updates</h2><ul>${r.rows.map((n) => `<li>${avatar(n.author ? n.author.replace(/ \(.*\)$/, "") : "", "sm")}<span><b>${h(n.author || "Someone")}</b> ${n.kind === "comment" ? "commented on" : h(n.body) + " ·"} <a href="${c.base}/t/${n.task_id}">${h(n.title)}</a>
      ${n.kind === "comment" ? `<span class="pj-quote">${h(n.body.length > 140 ? n.body.slice(0, 140) + "…" : n.body)}</span>` : ""}</span><time>${ago(n.created_at)}</time></li>`).join("")}</ul></section>`;
  }

  async function showBoard(req, res) {
    const c = await ctxOf(req);
    if (!c) return c === null && req.params.token ? gone(req, res) : res.redirect("/activities");
    if (c.shared) pool.query("UPDATE project_links SET last_used = now() WHERE id = $1", [c.link.id]).catch(() => {});
    const today = R.todayLocal(), view = req.query.view === "list" ? "list" : "board";
    const all = await tasksOf(c.ev.activity_id), s = summary(all, today);
    const team = s.teams.includes(req.query.team) ? req.query.team : "";
    const tasks = team ? all.filter((t) => t.team === team) : all;
    const head = c.shared ? sharedHead(c, s) : eventTabs(c.ev, "project", { tasks: all.length, signups: (await pool.query("SELECT count(*)::int AS n FROM participation WHERE activity_id = $1 AND voided_at IS NULL", [c.ev.activity_id])).rows[0].n });
    const empty = !all.length ? `<section class="card"><div class="empty"><b>No tasks yet</b><span>Break the event into tasks: who does what, by when. Share the board with other departments so they can add their part.</span>
      ${c.canEdit ? `<button class="btn primary" type="button" data-pj-new>+ Add the first task</button>` : ""}</div></section>` : "";
    res.send(out(req, c, "Project · " + c.ev.name, `${head}${overview(c, s, view, team)}${c.canEdit ? newTaskForm(c, await namesFor()) : ""}
      ${empty || (view === "list" ? list(c, tasks, today) : board(c, tasks, today))}${await recent(c)}`));
  }

  // ---------- one task ----------
  async function showTask(req, res) {
    const c = await ctxOf(req);
    if (!c) return req.params.token ? gone(req, res) : res.redirect("/activities");
    const t = await taskOf(c, req.params.tid);
    if (!t) return res.redirect(c.base);
    const notes = (await pool.query("SELECT * FROM project_notes WHERE task_id = $1 ORDER BY created_at, id", [t.id])).rows;
    const files = (await pool.query("SELECT id, note_id, name, mime, bytes, uploaded_by, created_at FROM project_files WHERE task_id = $1 ORDER BY created_at DESC, id DESC", [t.id])).rows;
    const today = R.todayLocal(), pct = t.status === "done" ? 100 : t.progress, ro = c.canEdit ? "" : "disabled";
    const fileRow = (f) => `<li><a class="pj-file" href="${c.base}/f/${f.id}" target="_blank" rel="noopener">${/^image\//.test(f.mime) ? `<img src="${c.base}/f/${f.id}" alt="" loading="lazy">` : `<span class="pj-ficon">${ico.file}<small>${h((f.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</small></span>`}
        <span><b>${h(f.name)}</b><small>${kb(f.bytes)} · ${h((f.uploaded_by || "").replace(/ \(.*\)$/, ""))} · ${ago(f.created_at)}</small></span></a></li>`;
    const byNote = (id) => files.filter((f) => f.note_id === id);
    const thread = notes.map((n) => n.kind === "comment"
      ? `<li class="pj-c">${avatar((n.author || "").replace(/ \(.*\)$/, ""))}<div class="pj-cbody"><p class="pj-chead"><b>${h(n.author || "Someone")}</b><time>${ago(n.created_at)}</time></p><p>${h(n.body).replace(/\n/g, "<br>")}</p>
          ${byNote(n.id).length ? `<ul class="pj-files inline">${byNote(n.id).map(fileRow).join("")}</ul>` : ""}</div></li>`
      : `<li class="pj-ev"><i class="dot ${h(n.body.includes("Done") ? "done" : n.body.includes("review") ? "review" : n.body.includes("progress") ? "doing" : "todo")}"></i><span><b>${h(n.author || "")}</b> ${h(n.body)}</span><time>${ago(n.created_at)}</time></li>`).join("");
    const back = `<a class="pj-back" href="${c.base}">← ${h(c.ev.name)} · Project</a>`;
    res.send(out(req, c, t.title, `${back}<div class="pj-detail">
      <section class="card pj-main">
        <p class="pj-crumbs">${t.team ? `<span class="pj-team">${h(t.team)}</span>` : ""}<span class="pj-chip ${t.status}">${ST[t.status]}</span>${t.priority === "High" ? `<span class="pj-high">High priority</span>` : ""}</p>
        ${c.canEdit ? `<form method="post" action="${c.base}/t/${t.id}" class="pj-titleform"><input type="hidden" name="only" value="text"><textarea class="pj-title" name="title" rows="1" maxlength="140" aria-label="Task title" required>${h(t.title)}</textarea>
          <textarea class="pj-notes" name="notes" maxlength="2000" placeholder="Add details: what done looks like, links, contacts…" aria-label="Details" rows="2">${h(t.notes || "")}</textarea>
          <div class="pj-savebar"><button class="btn primary">Save</button></div></form>`
          : `<h2 class="pj-title">${h(t.title)}</h2>${t.notes ? `<p class="pj-notes">${h(t.notes).replace(/\n/g, "<br>")}</p>` : ""}`}
        <h3 class="pj-h3">Comments & activity</h3>
        <ul class="pj-thread">${thread || `<li class="muted" style="padding:8px 0">No comments yet.</li>`}</ul>
        ${c.canEdit ? `<form class="pj-compose" id="pjEnd" method="post" action="${c.base}/t/${t.id}/comments" enctype="multipart/form-data">
          ${avatar(c.name)}<div class="pj-compose-box">${c.shared && !c.name ? `<input class="inp" name="your_name" required maxlength="60" placeholder="Your name">` : ""}
            <textarea name="body" rows="2" maxlength="4000" placeholder="Write an update or ask a question…"></textarea>
            <div class="pj-compose-bar"><label class="pj-attach">${ico.clip}<span>Attach</span><input type="file" name="files" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt"></label><span class="pj-picked" aria-live="polite"></span><button class="btn primary">Post</button></div></div></form>` : ""}
      </section>
      <aside class="pj-side">
        <section class="card"><form method="post" action="${c.base}/t/${t.id}" class="form pj-props">
          <fieldset class="pj-status"><legend>Status</legend><div class="pj-statusrow">${STATUS.map(([k, l]) => `<label><input type="radio" name="status" value="${k}" ${k === t.status ? "checked" : ""} ${ro}><span class="${k}">${l}</span></label>`).join("")}</div></fieldset>
          <label><span class="pj-plabel">Progress <output class="pj-out" for="pjRange">${pct}%</output></span><input id="pjRange" type="range" name="progress" min="0" max="100" step="5" value="${pct}" style="--v:${pct}%" ${ro}></label>
          <label>Owner<span class="pj-ownerin">${avatar(t.owner, "sm")}<input name="owner" list="pjOwners" maxlength="60" value="${h(t.owner || "")}" placeholder="Unassigned" ${ro}></span></label>
          <div class="row2"><label>Team<input name="team" list="pjTeams" maxlength="40" value="${h(t.team || "")}" ${ro}></label>
            <label>Due date<input type="date" name="due_date" value="${h(t.due_date || "")}" ${ro}></label></div>
          <label>Priority<select name="priority" ${ro}>${PRIORITY.map((p) => `<option ${t.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
          ${t.due_date && t.status !== "done" && t.due_date < today ? `<p class="pj-latenote">${dueChip(t, today)} Past its due date</p>` : ""}
          ${c.canEdit ? `<button class="btn primary">Save changes</button>` : ""}
        </form>${c.canEdit ? lists(await namesFor()) : ""}</section>
        <section class="card"><div class="card-head"><h2>Files <span class="pj-n">${files.length}</span></h2></div>
          <ul class="pj-files">${files.map(fileRow).join("") || `<li class="muted" style="font-size:13.5px">No files yet.</li>`}</ul>
          ${c.canEdit ? `<form method="post" action="${c.base}/t/${t.id}/files" enctype="multipart/form-data" class="pj-upload">
            ${c.shared && !c.name ? `<input class="inp" name="your_name" required maxlength="60" placeholder="Your name">` : ""}
            <label class="pj-dropzone">${ico.clip}<span><b>Upload files</b><small>Photos, PDF, Word, Excel · up to 10 MB each</small></span><input type="file" name="files" multiple required accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt" data-autosubmit></label></form>` : ""}
        </section>
        <p class="pj-made">Added by ${h(t.created_by || "—")} · ${ago(t.created_at)}${c.staff ? ` · <form method="post" action="${c.base}/t/${t.id}/delete" class="pj-del" data-confirm="Delete this task, its comments and files?"><button class="linkbtn">Delete task</button></form>` : ""}</p>
      </aside></div>`));
  }

  // ---------- changes ----------
  const readTask = (b, a = {}) => ({
    title: R.clean(b.title).slice(0, 140) || a.title, owner: b.owner === undefined ? a.owner : R.clean(b.owner).slice(0, 60) || null,
    team: b.team === undefined ? a.team : R.clean(b.team).slice(0, 40) || null,
    due_date: b.due_date === undefined ? a.due_date : /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || "") ? b.due_date : null,
    status: ST[b.status] ? b.status : a.status || "todo",
    priority: PRIORITY.includes(b.priority) ? b.priority : a.priority || "Normal",
    notes: b.notes === undefined ? a.notes : String(b.notes || "").trim().slice(0, 2000) || null,
  });
  // progress follows the status when the status moves and the slider wasn't touched
  const progressFor = (status, prev, asked) => (status === "done" ? 100 : asked != null ? Math.min(asked, 95) : prev.status === "done" ? 90 : status === "todo" && prev.status !== "todo" ? 0 : prev.progress);
  async function logEvent(c2, taskId, who, text) {
    await c2.query("INSERT INTO project_notes (task_id, kind, author, body) VALUES ($1,'event',$2,$3)", [taskId, who, text]);
  }

  const canEdit = (req, res, c) => {
    if (!c) { res.redirect(req.params.token ? "/pj/" + encodeURIComponent(req.params.token) : "/activities"); return false; }
    if (!c.canEdit) { res.status(403).send(page(req, "View only", `<section class="card"><h2>This link is view only</h2><p class="lead"><a href="${c.base}">Back to the board</a></p></section>`, { wide: false })); return false; }
    return true;
  };

  async function createTask(req, res) {
    const c = await ctxOf(req);
    if (!canEdit(req, res, c)) return;
    rememberName(req, c, req.body);
    const f = readTask(req.body);
    if (!f.title) { setFlash(req, "err", "Give the task a name."); return res.redirect(c.base); }
    const id = await tx(async (x) => {
      const id = (await x.query(`INSERT INTO project_tasks (activity_id, title, owner, team, due_date, status, priority, notes, progress, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [c.ev.activity_id, f.title, f.owner, f.team, f.due_date, f.status, f.priority, f.notes, f.status === "done" ? 100 : 0, c.who])).rows[0].id;
      await logEvent(x, id, c.who, "added this task");
      await audit(x, c.staff ? actor(req) : "Project link: " + c.link.team, "project.task.create", "project_task", String(id), null, { activity: c.ev.activity_id, ...f });
      return id;
    });
    setFlash(req, "ok", `Added “${f.title}”.`);
    res.redirect(303, c.base + (req.body.open ? `/t/${id}` : ""));
  }
  async function updateTask(req, res) {
    const c = await ctxOf(req);
    if (!canEdit(req, res, c)) return;
    const t = await taskOf(c, req.params.tid);
    if (!t) return res.redirect(c.base);
    const b = req.body || {}, textOnly = b.only === "text";
    const f = textOnly ? { ...t, title: R.clean(b.title).slice(0, 140) || t.title, notes: String(b.notes || "").trim().slice(0, 2000) || null } : readTask(b, t);
    const asked = !textOnly && /^\d{1,3}$/.test(String(b.progress || "")) && +b.progress !== (t.status === "done" ? 100 : t.progress) ? Math.min(100, +b.progress) : null;
    // dragging the slider to 100% finishes the task
    if (asked === 100) f.status = "done";
    const progress = f.status !== t.status ? progressFor(f.status, t, asked) : asked != null ? asked : t.progress;
    await tx(async (x) => {
      await x.query(`UPDATE project_tasks SET title=$2, owner=$3, team=$4, due_date=$5, status=$6, priority=$7, notes=$8, progress=$9, updated_at=now() WHERE id=$1`,
        [t.id, f.title, f.owner, f.team, f.due_date, f.status, f.priority, f.notes, progress]);
      if (f.status !== t.status) await logEvent(x, t.id, c.who, `moved it to ${ST[f.status]}`);
      else if (progress !== t.progress) await logEvent(x, t.id, c.who, `set progress to ${progress}%`);
      if ((f.owner || "") !== (t.owner || "")) await logEvent(x, t.id, c.who, f.owner ? `assigned it to ${f.owner}` : "removed the owner");
      if ((f.due_date || "") !== (t.due_date || "")) await logEvent(x, t.id, c.who, f.due_date ? `set the due date to ${fmtDate(f.due_date)}` : "removed the due date");
      await audit(x, c.staff ? actor(req) : "Project link: " + c.link.team, "project.task.update", "project_task", String(t.id), t, { ...f, progress });
    });
    setFlash(req, "ok", "Saved.");
    res.redirect(303, `${c.base}/t/${t.id}`);
  }
  // drag and drop on the board (JSON), or the status menu (form)
  async function moveTask(req, res) {
    const c = await ctxOf(req), json = req.is("application/json");
    if (!c || !c.canEdit) return json ? res.status(403).json({ error: "Not allowed." }) : canEdit(req, res, c);
    const t = await taskOf(c, req.params.tid), status = ST[req.body.status] ? req.body.status : null;
    if (!t || !status) return json ? res.status(400).json({ error: "Unknown task." }) : res.redirect(c.base);
    if (status !== t.status) {
      const progress = progressFor(status, t, null);
      await tx(async (x) => {
        await x.query("UPDATE project_tasks SET status = $2, progress = $3, updated_at = now() WHERE id = $1", [t.id, status, progress]);
        await logEvent(x, t.id, c.who, `moved it to ${ST[status]}`);
        await audit(x, c.staff ? actor(req) : "Project link: " + c.link.team, "project.task.move", "project_task", String(t.id), { status: t.status }, { status });
      });
    }
    if (json) {
      const s = summary(await tasksOf(c.ev.activity_id), R.todayLocal());
      return res.json({ ok: true, summary: s });
    }
    const back = req.get("referer") || "";
    res.redirect(303, /\?view=list|&view=list/.test(back) ? c.base + "?view=list" : c.base);
  }
  const takeFiles = (req, res, next) => upload.array("files", MAX_FILES)(req, res, (err) => {
    if (err) req.uploadError = err.code === "LIMIT_FILE_SIZE" ? "A file is too large (10 MB max)." : err.code === "LIMIT_FILE_COUNT" ? `Up to ${MAX_FILES} files at a time.` : "The files couldn't be uploaded.";
    next();
  });
  const fileName = (s) => String(Buffer.from(s || "file", "latin1").toString("utf8")).replace(/[\\/\r\n"<>]/g, "_").slice(0, 120) || "file";
  async function saveFiles(x, c, taskId, noteId, files) {
    for (const f of files) {
      await x.query("INSERT INTO project_files (task_id, note_id, name, mime, bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [taskId, noteId, fileName(f.originalname), f.mimetype, f.size, f.buffer, c.who]);
    }
  }
  async function addComment(req, res) {
    const c = await ctxOf(req);
    if (!canEdit(req, res, c)) return;
    const t = await taskOf(c, req.params.tid);
    if (!t) return res.redirect(c.base);
    rememberName(req, c, req.body || {});
    const body = String((req.body || {}).body || "").trim().slice(0, 4000);
    const files = (req.files || []).filter((f) => FILE_OK.test(f.mimetype)), skipped = (req.files || []).length - files.length;
    const err = req.uploadError || (c.shared && !c.name ? "Add your name, so the team knows who wrote it." : !body && !files.length ? "Write a comment or attach a file." : null);
    if (err) { setFlash(req, "err", err); return res.redirect(303, `${c.base}/t/${t.id}`); }
    await tx(async (x) => {
      const nid = (await x.query("INSERT INTO project_notes (task_id, kind, author, body) VALUES ($1,'comment',$2,$3) RETURNING id", [t.id, c.who, body || `Shared ${files.length} file${files.length > 1 ? "s" : ""}`])).rows[0].id;
      await saveFiles(x, c, t.id, nid, files);
      await x.query("UPDATE project_tasks SET updated_at = now() WHERE id = $1", [t.id]);
    });
    if (skipped) setFlash(req, "err", `${skipped} file${skipped > 1 ? "s were" : " was"} skipped: only photos, PDF, Word, Excel, PowerPoint, CSV and text files.`);
    res.redirect(303, `${c.base}/t/${t.id}#pjEnd`);
  }
  async function addFiles(req, res) {
    const c = await ctxOf(req);
    if (!canEdit(req, res, c)) return;
    const t = await taskOf(c, req.params.tid);
    if (!t) return res.redirect(c.base);
    rememberName(req, c, req.body || {});
    const files = (req.files || []).filter((f) => FILE_OK.test(f.mimetype));
    const err = req.uploadError || (c.shared && !c.name ? "Add your name first." : !files.length ? "Choose a photo, PDF, Word, Excel or PowerPoint file." : null);
    if (err) { setFlash(req, "err", err); return res.redirect(303, `${c.base}/t/${t.id}`); }
    await tx(async (x) => {
      await saveFiles(x, c, t.id, null, files);
      await logEvent(x, t.id, c.who, `uploaded ${files.length === 1 ? fileName(files[0].originalname) : files.length + " files"}`);
    });
    setFlash(req, "ok", `Uploaded ${files.length} file${files.length > 1 ? "s" : ""}.`);
    res.redirect(303, `${c.base}/t/${t.id}`);
  }
  async function getFile(req, res) {
    const c = await ctxOf(req);
    if (!c) return res.status(404).end();
    const f = (await pool.query(`SELECT f.* FROM project_files f JOIN project_tasks t ON t.id = f.task_id WHERE f.id = $1 AND t.activity_id = $2`, [+req.params.fid || 0, c.ev.activity_id])).rows[0];
    if (!f) return res.status(404).end();
    const inline = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.mime);
    res.type(f.mime).set({ "Cache-Control": "private, max-age=3600", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}` }).send(f.data);
  }

  // ---------- routes: staff and shared links run the same handlers ----------
  const sharedPost = limit("project", 120, 60 * 60e3);
  for (const [base, gate, postGate] of [["/activities/:id/project", STAFF, STAFF], ["/pj/:token", (req, res, next) => next(), sharedPost]]) {
    app.get(base, gate, wrap(showBoard));
    app.post(base + "/tasks", postGate, wrap(createTask));
    app.get(base + "/t/:tid", gate, wrap(showTask));
    app.post(base + "/t/:tid", postGate, wrap(updateTask));
    app.post(base + "/t/:tid/move", postGate, wrap(moveTask));
    app.post(base + "/t/:tid/comments", postGate, takeFiles, wrap(addComment));
    app.post(base + "/t/:tid/files", postGate, takeFiles, wrap(addFiles));
    app.get(base + "/f/:fid", gate, wrap(getFile));
  }
  app.post("/activities/:id/project/t/:tid/delete", STAFF, wrap(async (req, res) => {
    const c = await ctxOf(req);
    if (!c) return res.redirect("/activities");
    await tx(async (x) => {
      const t = (await x.query("DELETE FROM project_tasks WHERE id = $1 AND activity_id = $2 RETURNING id, title, owner, status", [+req.params.tid || 0, c.ev.activity_id])).rows[0];
      if (t) await audit(x, actor(req), "project.task.delete", "project_task", String(t.id), t, null);
    });
    setFlash(req, "ok", "Task deleted.");
    res.redirect(303, c.base);
  }));

  // ---------- sharing with other departments ----------
  app.get("/activities/:id/project/share", STAFF, wrap(async (req, res) => {
    const c = await ctxOf(req);
    if (!c) return res.redirect("/activities");
    const links = (await pool.query("SELECT * FROM project_links WHERE activity_id = $1 ORDER BY active DESC, created_at", [c.ev.activity_id])).rows;
    const tasks = await tasksOf(c.ev.activity_id);
    const row = (l) => {
      const url = `${baseOf(req)}/pj/${l.token}`, mine = tasks.filter((t) => t.team === l.team).length;
      const msg = `Hi ${l.team} team! This is the project board for ${c.ev.name}${c.ev.event_date ? " (" + fmtDate(c.ev.event_date) + ")" : ""}. ${l.can_edit ? "Add your tasks, update progress, comment and upload files here" : "Follow the tasks and progress here"}: ${url}`;
      return `<li class="pj-link ${l.active ? "" : "off"}"><span class="pj-link-av">${h(initials(l.team))}</span>
        <div class="pj-link-main"><p><b>${h(l.team)}</b> <span class="badge ${l.can_edit ? "good" : ""}">${l.can_edit ? "Can contribute" : "View only"}</span>${l.active ? "" : ' <span class="badge">Off</span>'}</p>
          <p class="muted">${mine} task${mine === 1 ? "" : "s"} for this team · ${l.last_used ? "opened " + ago(l.last_used) : "not opened yet"}</p>
          ${l.active ? `<div class="pj-link-url"><input class="inp" value="${h(url)}" readonly aria-label="Link for ${h(l.team)}"><button class="btn primary" type="button" data-copy="${h(url)}">Copy</button><a class="btn" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>
        <form method="post" action="${c.base}/share/${l.id}" class="pj-link-act">${l.active ? `<button class="btn tblbtn" name="can_edit" value="${l.can_edit ? "0" : "1"}">${l.can_edit ? "Make view only" : "Allow edits"}</button><button class="btn tblbtn danger" name="active" value="0">Switch off</button>` : `<button class="btn tblbtn" name="active" value="1">Switch on</button>`}</form></li>`;
    };
    res.send(out(req, c, "Share · " + c.ev.name, `${eventTabs(c.ev, "project", { tasks: tasks.length })}
      <a class="pj-back" href="${c.base}">← Back to the board</a>
      <div class="grid">
      <section class="card c7"><h2>Departments on this project</h2><p class="lead">Each department gets its own link. No account or password: whoever has the link sees this event's board. Switch a link off at any time.</p>
        <ul class="pj-links">${links.map(row).join("") || `<li class="muted">Not shared yet.</li>`}</ul></section>
      <section class="card c5"><h2>Invite a department</h2>
        <form class="form" method="post" action="${c.base}/share">
          <label>Department<input name="team" list="pjTeams" required maxlength="40" placeholder="e.g. Marketing"></label>
          <fieldset class="pj-perm"><legend>What can they do?</legend>
            <label><input type="radio" name="can_edit" value="1" checked><span><b>Contribute</b><small>Add tasks, move them, update progress, comment and upload files.</small></span></label>
            <label><input type="radio" name="can_edit" value="0"><span><b>View only</b><small>See the tasks, progress, comments and files.</small></span></label></fieldset>
          <button class="btn primary">Make a link</button></form>${lists([])}
        <div class="pj-perms"><p><b>What a department can never do</b></p><ul><li>See other events, members, sign-ups or payments</li><li>Delete tasks or change who the project is shared with</li></ul></div></section></div>`));
  }));
  app.post("/activities/:id/project/share", STAFF, wrap(async (req, res) => {
    const c = await ctxOf(req);
    if (!c) return res.redirect("/activities");
    const team = R.clean(req.body.team).slice(0, 40);
    if (!team) return res.redirect(c.base + "/share");
    const canE = req.body.can_edit !== "0";
    await pool.query("INSERT INTO project_links (activity_id, token, team, can_edit, created_by) VALUES ($1,$2,$3,$4,$5)", [c.ev.activity_id, crypto.randomBytes(12).toString("base64url"), team, canE, actor(req)]);
    await audit(pool, actor(req), "project.share", "activity", c.ev.activity_id, null, { team, can_edit: canE });
    setFlash(req, "ok", `Link made for ${team}. Copy it or send it on WhatsApp.`);
    res.redirect(303, c.base + "/share");
  }));
  app.post("/activities/:id/project/share/:lid", STAFF, wrap(async (req, res) => {
    const c = await ctxOf(req);
    if (!c) return res.redirect("/activities");
    const l = (await pool.query("SELECT * FROM project_links WHERE id = $1 AND activity_id = $2", [+req.params.lid || 0, c.ev.activity_id])).rows[0];
    if (l) {
      const active = req.body.active != null ? req.body.active === "1" : l.active, canE = req.body.can_edit != null ? req.body.can_edit === "1" : l.can_edit;
      await pool.query("UPDATE project_links SET active = $2, can_edit = $3 WHERE id = $1", [l.id, active, canE]);
      await audit(pool, actor(req), "project.share.update", "activity", c.ev.activity_id, { team: l.team, active: l.active, can_edit: l.can_edit }, { active, can_edit: canE });
    }
    res.redirect(303, c.base + "/share");
  }));
};
module.exports.eventTabs = eventTabs;
module.exports.progressByEvent = progressByEvent;
module.exports.summary = summary;
