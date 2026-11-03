"use strict";
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { pool, tx, audit, getSettings } = require("./db");
const R = require("./rules");
const { h, fmtTs, ROLE_TEXT } = require("./views");
const { parseWorkbook, commitImport } = require("./importer");
const { exportWorkbook } = require("./exporter");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const previews = new Map(); // token -> { parsed, name, at, by }

module.exports = function admin(app, { need, page, setFlash, actor, user, wrap }) {
  const A = need("admin");

  app.get("/admin", A, wrap(async (req, res) => {
    const c = (await pool.query(`SELECT (SELECT count(*) FROM members) m, (SELECT count(*) FROM participation) p, (SELECT max(at) FROM audit_log WHERE action LIKE 'import%') imp,
      (SELECT max(at) FROM audit_log WHERE action = 'export') exp, (SELECT count(*) FROM users WHERE active) u`)).rows[0];
    res.send(page(req, "Admin", `<div class="grid">
      <section class="card c6"><h2>Backup</h2><p class="lead">Download everything as an Excel workbook: members, all activity rows, history, rides & events, and the audit log. Do this weekly. On Render's free plan the database is deleted 30 days after it was created.</p>
        <form class="toolbar" method="post" action="/admin/export.xlsx" style="align-items:center"><input class="inp" type="password" name="password" required autocomplete="current-password" placeholder="Your password" style="max-width:220px"><button class="btn primary">Download backup (.xlsx)</button></form>
        <p class="muted" style="font-size:13px">The backup holds every member's contact details. Keep it in a restricted SharePoint folder, never email it, and delete local copies.</p><p class="muted">Last backup: ${fmtTs(c.exp)}</p></section>
      <section class="card c6"><h2>Import the workbook</h2><p class="lead">One-time move from WMF_Community_Master_System_Integrated.xlsx. Shows a preview first; nothing is written until you confirm.</p>
        <p><a class="btn" href="/admin/import">Import…</a></p><p class="muted">${Number(c.m).toLocaleString("en-GB")} members and ${Number(c.p).toLocaleString("en-GB")} activity rows in the database. Last import: ${fmtTs(c.imp)}</p></section>
      <section class="card c4"><h2>Staff accounts</h2><p class="lead">${c.u} active accounts.</p><a class="btn" href="/admin/users">Manage accounts</a></section>
      <section class="card c4"><h2>Counting settings</h2><p class="lead">Test entries to leave out, and large events reported separately.</p><a class="btn" href="/admin/settings">Settings</a></section>
      <section class="card c4"><h2>Audit log</h2><p class="lead">Every change, check-in, import and export.</p><a class="btn" href="/admin/audit">Open audit log</a></section>
      <section class="card c6"><h2>Corporate programme</h2><p class="lead">Import the corporate tracker, and set each partner's name, ride days and colour.</p><a class="btn" href="/corporate/admin">Corporate settings</a></section>
      <section class="card c6"><h2>Department</h2><p class="lead">Team list, public holidays, attendance and leave.</p><a class="btn" href="/department/staff">Staff & holidays</a></section>
      <section class="card c12"><h2>Email</h2><p class="lead">The app sends no email. New members get their QR code on screen at registration, and staff can download any member's code from the member page.</p></section>
    </div>`, { active: "/admin" }));
  }));

  // ---------- import ----------
  app.get("/admin/import", A, (req, res) => {
    res.send(page(req, "Import", `<section class="card"><h2>Import the WMF workbook</h2>
      <p class="lead">Choose WMF_Community_Master_System_Integrated.xlsx. The file is read, never changed. Member IDs and QR values are kept exactly, so the QR codes already sent keep working.</p>
      <form class="form" method="post" action="/admin/import" enctype="multipart/form-data">
        <input type="file" name="file" accept=".xlsx" required>
        <button class="btn primary">Read file and preview</button></form></section>`, { active: "/admin", wide: false }));
  });
  app.post("/admin/import", A, upload.single("file"), wrap(async (req, res) => {
    if (!req.file) { setFlash(req, "err", "Choose a file."); return res.redirect("/admin/import"); }
    let parsed;
    try { parsed = await parseWorkbook(req.file.buffer); } catch (e) { setFlash(req, "err", "Couldn't read that file: " + e.message); return res.redirect("/admin/import"); }
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60e3) previews.delete(k);
    const token = crypto.randomBytes(16).toString("hex");
    previews.set(token, { parsed, name: req.file.originalname, at: Date.now(), by: actor(req) });
    const s = parsed.summary;
    const have = Number((await pool.query("SELECT count(*) n FROM members")).rows[0].n);
    res.send(page(req, "Import preview", `<section class="card"><h2>Preview: ${h(req.file.originalname)}</h2>
      <p class="lead">Nothing has been written yet.</p>
      <dl class="kv"><dt>Members</dt><dd>${s.members}</dd><dt>QR value = Member ID</dt><dd>${s.qrValuesMatchIds} of ${s.members}</dd>
      <dt>Highest Member ID</dt><dd>${h(s.highestMemberId)} (new members continue from the next number)</dd>
      <dt>Activity rows</dt><dd>${s.activity} (${s.activityLinked} linked to a member record)</dd><dt>Rides & events (Activity Setup)</dt><dd>${s.activities}</dd>
      <dt>Historical ride sessions</dt><dd>${s.historyRides}</dd><dt>Historical events</dt><dd>${s.historyEvents}</dd></dl>
      ${parsed.warnings.length ? `<h3 style="margin-top:14px">Notes</h3><ul>${parsed.warnings.map((w) => `<li>${h(w)}</li>`).join("")}</ul>` : ""}
      <form class="form" method="post" action="/admin/import/commit" style="margin-top:14px">
        <input type="hidden" name="token" value="${token}">
        ${have ? `<div class="alert crit"><span class="ic">!</span><span>The database already holds ${have} members. Importing replaces <b>all</b> members, activity rows (including app check-ins and sign-ups) and history. Download a backup first.</span></div>
          <label>Type REPLACE to confirm<input name="confirm" required pattern="REPLACE"></label>` : ""}
        <button class="btn primary big">Import now</button></form></section>`, { active: "/admin", wide: false }));
  }));
  app.post("/admin/import/commit", A, wrap(async (req, res) => {
    const p = previews.get(String(req.body.token || ""));
    if (!p) { setFlash(req, "err", "The preview expired. Upload the file again."); return res.redirect("/admin/import"); }
    const have = Number((await pool.query("SELECT count(*) n FROM members")).rows[0].n);
    if (have && req.body.confirm !== "REPLACE") { setFlash(req, "err", "Type REPLACE to confirm."); return res.redirect("/admin/import"); }
    const out = await commitImport(p.parsed, actor(req), { replace: !!have, fileName: p.name });
    previews.delete(String(req.body.token));
    setFlash(req, "ok", `Imported ${out.members} members and ${out.activity} activity rows. New Member IDs start after ${p.parsed.summary.highestMemberId}.`);
    res.redirect("/admin");
  }));

  // ---------- export ----------
  app.post("/admin/export.xlsx", A, wrap(async (req, res) => {
    // the full contact list leaves the system only after the administrator confirms their password
    const u = (await pool.query("SELECT password_hash FROM users WHERE id = $1", [user(req).id])).rows[0];
    if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))) {
      await audit(pool, actor(req), "export.refused", "workbook", null, null, null, "Wrong password");
      setFlash(req, "err", "Password not right. The backup was not downloaded.");
      return res.redirect("/admin");
    }
    const buf = await exportWorkbook();
    await audit(pool, actor(req), "export", "workbook", null, null, null, null);
    const stamp = R.nowLocal().slice(0, 16).replace(/[-:T]/g, "");
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="WMF_Backup_${stamp}.xlsx"`).send(buf);
  }));

  // ---------- users ----------
  app.get("/admin/users", A, wrap(async (req, res) => {
    const r = await pool.query("SELECT * FROM users ORDER BY active DESC, role, email");
    const cos = (await pool.query("SELECT code, name FROM corp_companies ORDER BY sort_order, name")).rows;
    const coSel = (cur) => `<select class="inp" name="company" style="width:auto;min-height:32px;font-size:14px" aria-label="Limit to one partner"><option value="">Everything</option>${cos.map((c) => `<option value="${h(c.code)}" ${cur === c.code ? "selected" : ""}>Only ${h(c.name)}</option>`).join("")}</select>`;
    const temp = req.session.tempPassword; delete req.session.tempPassword;
    res.send(page(req, "Accounts", `
      ${temp ? `<div class="flash ok" role="status">Temporary password for ${h(temp.email)}: <b style="font-family:monospace;font-size:16px">${h(temp.pw)}</b>. Share it privately. They choose their own at first sign-in. It won't be shown again.</div>` : ""}
      <div class="grid"><section class="card c8"><h2>Staff accounts</h2>
      <p class="lead">Administrator: everything. Coordinator (ride leads and department staff): WMF and corporate scanning, attendance, members, events, and their own attendance & leave. Viewer (managers): dashboards and reports without names. Sponsor: aggregate dashboards, small WMF counts shown as &lt;5. “Only &lt;partner&gt;” limits a viewer or sponsor to that company's corporate dashboard and report.</p>
      <div class="tw"><table><thead><tr><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${r.rows.map((u) => `<tr ${u.active ? "" : 'style="opacity:.55"'}><td>${h(u.email)}<br><span class="muted">${h(u.name)}</span></td><td>${h(ROLE_TEXT[u.role])}${u.company ? " · only " + h(u.company) : ""}${u.active ? "" : " (disabled)"}</td><td>${fmtTs(u.last_login)}</td>
        <td><form method="post" action="/admin/users/${u.id}" class="toolbar" style="margin:0">
          <select class="inp" name="role" style="width:auto;min-height:32px;font-size:14px">${Object.entries(ROLE_TEXT).map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          ${coSel(u.company)}
          <select class="inp" name="active" style="width:auto;min-height:32px;font-size:14px"><option value="1" ${u.active ? "selected" : ""}>Active</option><option value="0" ${u.active ? "" : "selected"}>Disabled</option></select>
          <label class="check" style="display:inline-flex;gap:4px;font-size:14px"><input type="checkbox" name="reset" value="1"> New password</label>
          <button class="btn tblbtn">Save</button></form></td></tr>`).join("")}
      </tbody></table></div></section>
      <section class="card c4"><h2>Add an account</h2><form class="form" method="post" action="/admin/users">
        <label>Email<input name="email" type="email" required></label><label>Name<input name="name" maxlength="80"></label>
        <label>Role<select name="role">${Object.entries(ROLE_TEXT).map(([k, l]) => `<option value="${k}" ${k === "coordinator" ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Access <span class="hint">(for a company's sponsor or manager)</span>${coSel("").replace(/ style="[^"]*"/, "")}</label>
        <button class="btn primary">Create with a temporary password</button></form></section></div>`, { active: "/admin" }));
  }));
  // only viewers and sponsors can be limited to one partner; staff roles always see everything
  const companyFor = async (code, role) => (["viewer", "sponsor"].includes(role) && code && (await pool.query("SELECT 1 FROM corp_companies WHERE code = $1", [code])).rows[0] ? code : null);
  const tempPw = () => crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "x");
  app.post("/admin/users", A, wrap(async (req, res) => {
    const email = R.normEmail(req.body.email), role = req.body.role;
    const company = await companyFor(req.body.company, role);
    if (!R.EMAIL_RE.test(email) || !ROLE_TEXT[role]) { setFlash(req, "err", "Enter an email and a role."); return res.redirect("/admin/users"); }
    const pw = tempPw();
    try {
      await pool.query("INSERT INTO users (email, name, role, password_hash, company) VALUES ($1,$2,$3,$4,$5)", [email, R.clean(req.body.name), role, await bcrypt.hash(pw, 11), company]);
    } catch (e) { setFlash(req, "err", "That email already has an account."); return res.redirect("/admin/users"); }
    await audit(pool, actor(req), "user.create", "user", email, null, { role, company }, null);
    req.session.tempPassword = { email, pw };
    res.redirect("/admin/users");
  }));
  app.post("/admin/users/:id", A, wrap(async (req, res) => {
    const u = (await pool.query("SELECT * FROM users WHERE id = $1", [+req.params.id])).rows[0];
    if (!u) return res.redirect("/admin/users");
    const role = ROLE_TEXT[req.body.role] ? req.body.role : u.role, active = req.body.active !== "0";
    if (u.id === user(req).id && (role !== "admin" || !active)) { setFlash(req, "err", "You can't remove your own administrator access."); return res.redirect("/admin/users"); }
    const company = await companyFor(req.body.company, role);
    await pool.query("UPDATE users SET role = $2, active = $3, company = $4 WHERE id = $1", [u.id, role, active, company]);
    if (!active || role !== u.role || company !== u.company) await pool.query(`DELETE FROM "session" WHERE (sess->'user'->>'id')::int = $1`, [u.id]); // sign them out everywhere
    if (req.body.reset) {
      const pw = tempPw();
      await pool.query("UPDATE users SET password_hash = $2, must_change = true WHERE id = $1", [u.id, await bcrypt.hash(pw, 11)]);
      req.session.tempPassword = { email: u.email, pw };
    }
    await audit(pool, actor(req), "user.update", "user", u.email, { role: u.role, active: u.active, company: u.company }, { role, active, company, passwordReset: !!req.body.reset }, null);
    if (!req.body.reset) setFlash(req, "ok", "Saved.");
    res.redirect("/admin/users");
  }));

  // ---------- settings ----------
  app.get("/admin/settings", A, wrap(async (req, res) => {
    const s = await getSettings();
    res.send(page(req, "Settings", `<section class="card"><h2>Counting settings</h2>
      <form class="form" method="post" action="/admin/settings">
        <label>Test entries to leave out <span class="hint">(one email per line)</span><textarea name="excludeEmails" rows="4">${h((s.excludeEmails || []).join("\n"))}</textarea></label>
        <label>Large events reported separately <span class="hint">(one event name per line, exactly as in the data)</span><textarea name="separateEvents" rows="4">${h((s.separateEvents || []).join("\n"))}</textarea></label>
        <button class="btn primary">Save</button></form></section>`, { active: "/admin", wide: false }));
  }));
  app.post("/admin/settings", A, wrap(async (req, res) => {
    const before = await getSettings();
    const lines = (v) => String(v || "").split(/\r?\n/).map(R.clean).filter(Boolean);
    const after = { excludeEmails: lines(req.body.excludeEmails).map(R.normEmail), separateEvents: lines(req.body.separateEvents) };
    await tx(async (c) => {
      for (const [k, v] of Object.entries(after)) await c.query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2", [k, JSON.stringify(v)]);
      await audit(c, actor(req), "settings.update", "settings", null, { excludeEmails: before.excludeEmails, separateEvents: before.separateEvents }, after, null);
    });
    setFlash(req, "ok", "Saved. The dashboard uses the new settings at once.");
    res.redirect("/admin/settings");
  }));

  // ---------- audit ----------
  app.get("/admin/audit", A, wrap(async (req, res) => {
    const pg = Math.max(1, +req.query.page || 1), per = 100, q = R.clean(req.query.q);
    const args = [], where = q ? (args.push("%" + q.replace(/[%_]/g, "") + "%"), "WHERE action ILIKE $1 OR entity_id ILIKE $1 OR actor ILIKE $1") : "";
    const r = await pool.query(`SELECT * FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ${per + 1} OFFSET ${(pg - 1) * per}`, args);
    const more = r.rows.length > per;
    res.send(page(req, "Audit log", `<section class="card"><h2>Audit log</h2>
      <form class="toolbar" method="get"><input class="inp" type="search" name="q" value="${h(q)}" placeholder="Action, record or person" style="max-width:320px"><button class="btn">Filter</button></form>
      <div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Reason</th><th>Details</th></tr></thead><tbody>
      ${r.rows.slice(0, per).map((a) => `<tr><td>${fmtTs(a.at)}</td><td>${h(a.actor)}</td><td>${h(a.action)}</td><td>${a.entity === "member" ? `<a href="/members/${encodeURIComponent(a.entity_id)}">${h(a.entity_id)}</a>` : h(a.entity_id || "")}</td><td>${h(a.reason || "")}</td>
        <td><pre class="json">${h(a.after ? JSON.stringify(R.maskDeep(a.after)) : "")}</pre></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`}
      </tbody></table></div>
      <div class="pager">${pg > 1 ? `<a class="btn" href="?page=${pg - 1}&q=${encodeURIComponent(q)}">Newer</a>` : ""}${more ? `<a class="btn" href="?page=${pg + 1}&q=${encodeURIComponent(q)}">Older</a>` : ""}</div></section>`, { active: "/admin" }));
  }));
};
