"use strict";
/**
 * Event projects: the summary figures, and (with TEST_DATABASE_URL) the board end to end: staff add and move tasks,
 * a department's link can contribute (task, comment, file) or only view, and a switched-off link stops working.
 * Uses its own schema ("projects_test"), so it can run alongside the other test files.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB + (DB.includes("?") ? "&" : "?") + "options=-c%20search_path%3Dprojects_test";
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "first-Password-1";
}
const P = require("../src/projects");

test("summary: progress, overdue, due this week, teams", () => {
  const today = "2026-11-19";
  const s = P.summary([
    { status: "done", progress: 100, due_date: "2026-11-10", team: "WMF" },
    { status: "doing", progress: 50, due_date: "2026-11-18", team: "Marketing" },
    { status: "review", progress: 90, due_date: "2026-11-22", team: "Finance" },
    { status: "todo", progress: 0, due_date: null, team: "Marketing" },
  ], today);
  assert.deepEqual([s.total, s.done, s.pct, s.late, s.week, s.review], [4, 1, 60, 1, 1, 1]);
  assert.deepEqual(s.teams, ["WMF", "Marketing", "Finance"]);
  assert.equal(P.summary([], today).pct, 0);
});

test("board, sharing and contributions", { skip: !DB && "set TEST_DATABASE_URL" }, async (t) => {
  const { pool } = require("../src/db");
  const { app, init } = require("../src/server");
  await pool.query("DROP SCHEMA IF EXISTS projects_test CASCADE; CREATE SCHEMA projects_test;");
  await init();
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { server.close(); await pool.end(); });
  const ev = "/activities/ACT-RIDE-IT-FORWARD-DAY/project";

  assert.equal((await fetch(base + ev, { redirect: "manual" })).status, 302, "the board is for staff");
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ email: "admin@test.local", password: "first-Password-1", next: "/" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await fetch(base + "/account/password", { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ current: "first-Password-1", password: "Second-Password-2" }) });
  const post = (path, body, c = cookie) => fetch(base + path, { method: "POST", redirect: "manual", headers: { cookie: c, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

  // staff add a task; it shows on the board and on the events list
  assert.equal((await post(ev + "/tasks", { title: "Book the photographer", owner: "Nadia Farouk", team: "Media", due_date: "2026-12-01", status: "todo" })).status, 303);
  const task = (await pool.query("SELECT * FROM project_tasks")).rows[0];
  assert.equal(task.title, "Book the photographer");
  let html = await (await fetch(base + ev, { headers: { cookie } })).text();
  assert.match(html, /Book the photographer/);
  assert.match(html, /Nadia Farouk/);
  assert.match(await (await fetch(base + "/activities", { headers: { cookie } })).text(), new RegExp(ev));

  // drag and drop (JSON): moving to Done sets 100%, moving back sets it below 100
  const mv = await fetch(base + `${ev}/t/${task.id}/move`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
  assert.equal(mv.status, 200);
  assert.deepEqual([(await mv.json()).summary.pct], [100]);
  await post(`${ev}/t/${task.id}/move`, { status: "doing" });
  assert.deepEqual((await pool.query("SELECT status, progress FROM project_tasks WHERE id = $1", [task.id])).rows[0], { status: "doing", progress: 90 });
  // the task page: progress to 100% finishes the task
  await post(`${ev}/t/${task.id}`, { title: task.title, owner: "Nadia Farouk", team: "Media", due_date: "2026-12-01", status: "doing", priority: "High", progress: "100" });
  assert.equal((await pool.query("SELECT status FROM project_tasks WHERE id = $1", [task.id])).rows[0].status, "done");

  // share with Marketing (contribute) and Finance (view only)
  await post(ev + "/share", { team: "Marketing", can_edit: "1" });
  await post(ev + "/share", { team: "Finance", can_edit: "0" });
  const links = Object.fromEntries((await pool.query("SELECT team, token, id FROM project_links")).rows.map((l) => [l.team, l]));
  const mk = "/pj/" + links.Marketing.token, fi = "/pj/" + links.Finance.token;
  html = await (await fetch(base + mk)).text();
  assert.match(html, /Book the photographer/);
  assert.match(html, /You can add tasks/);
  assert.doesNotMatch(html, /Sign-ups/, "a department sees the board only");

  // Marketing adds a task and a comment with a file, signed with a name
  const anon = (await fetch(base + mk)).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.equal((await post(mk + "/tasks", { title: "Teaser post", team: "Marketing", your_name: "Layla Haddad" }, anon)).status, 303);
  const tp = (await pool.query("SELECT * FROM project_tasks WHERE title = 'Teaser post'")).rows[0];
  assert.equal(tp.created_by, "Layla Haddad (Marketing)");
  const fd = new FormData();
  fd.append("body", "Poster attached");
  fd.append("your_name", "Layla Haddad");
  fd.append("files", new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }), "poster.pdf");
  assert.equal((await fetch(base + `${mk}/t/${tp.id}/comments`, { method: "POST", redirect: "manual", headers: { origin: base }, body: fd })).status, 303);
  const f = (await pool.query("SELECT * FROM project_files")).rows[0];
  assert.deepEqual([f.name, f.uploaded_by], ["poster.pdf", "Layla Haddad (Marketing)"]);
  assert.equal((await fetch(base + `${mk}/f/${f.id}`)).status, 200);
  assert.match(await (await fetch(base + `${ev}/t/${tp.id}`, { headers: { cookie } })).text(), /Poster attached/);

  // Finance can look but not change anything; a department can't delete
  assert.equal((await fetch(base + fi)).status, 200);
  assert.equal((await post(`${fi}/t/${tp.id}/move`, { status: "done" }, "")).status, 403);
  assert.equal((await post(fi + "/tasks", { title: "Nope" }, "")).status, 403);
  assert.equal((await post(`${mk}/t/${tp.id}/delete`, {}, anon)).status, 404);
  // a task from another event is never reachable through this link
  assert.equal((await fetch(base + `${fi}/t/999999`, { redirect: "manual" })).status, 302);

  // switching a link off closes it
  await post(`${ev}/share/${links.Marketing.id}`, { active: "0" });
  assert.equal((await fetch(base + mk)).status, 404);
});
