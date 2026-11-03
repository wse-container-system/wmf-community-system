"use strict";
/**
 * Duplicate members. Same email = same person: merged automatically, keeping the oldest record.
 * Same phone or same full name = maybe the same person: listed for an administrator to decide.
 * Every merge can be undone; the merged record's Member ID (and so its QR code) keeps working.
 */
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate } = require("./views");

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const emailsOf = (m) => [m.primary_email, ...String(m.alt_emails || "").split(/[;,\s]+/)].map(R.normEmail).filter((e) => e.includes("@"));
const nameKey = (n) => { const w = R.clean(n).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean); return w.length >= 2 ? w.sort().join(" ") : ""; };
/** The record to keep: the one seen first (its Member ID is the oldest). */
const oldestFirst = (a, b) => String(a.first_seen || "9999").localeCompare(String(b.first_seen || "9999")) || a.member_id.localeCompare(b.member_id);

/** Merge `otherId` into `keepId`. Returns the merge id, or a message when it can't be done. */
async function mergeMembers(c, keepId, otherId, actor, reason) {
  const a = (await c.query("SELECT * FROM members WHERE member_id = $1 FOR UPDATE", [keepId])).rows[0];
  const b = (await c.query("SELECT * FROM members WHERE member_id = $1 FOR UPDATE", [otherId])).rows[0];
  if (!a || !b) return { err: "Member not found." };
  if (a.member_id === b.member_id || a.merged_into || b.merged_into) return { err: "These records can't be merged." };
  const alts = new Set(emailsOf(a).filter((e) => e !== R.normEmail(a.primary_email)));
  for (const e of emailsOf(b)) if (e !== R.normEmail(a.primary_email)) alts.add(e);
  const moved = (await c.query("UPDATE participation SET member_id = $1 WHERE member_id = $2 RETURNING id", [a.member_id, b.member_id])).rows.map((r) => r.id);
  const keptBefore = { alt_emails: a.alt_emails, mobile: a.mobile, first_seen: a.first_seen, full_name: a.full_name, primary_email: a.primary_email };
  const firstSeen = [a.first_seen, b.first_seen].filter(Boolean).sort()[0] || null;
  await c.query(`UPDATE members SET alt_emails = $2, mobile = coalesce(mobile, $3), primary_email = coalesce(primary_email, $4), first_seen = $5,
     full_name = CASE WHEN coalesce(full_name, '') = '' THEN $6 ELSE full_name END, updated_at = now() WHERE member_id = $1`,
  [a.member_id, [...alts].join("; ") || null, b.mobile, R.normEmail(b.primary_email) || null, firstSeen, b.full_name]);
  await c.query("UPDATE members SET merged_into = $1, updated_at = now() WHERE member_id = $2", [a.member_id, b.member_id]);
  const id = (await c.query("INSERT INTO merges (actor, reason, kept, merged, moved_ids, kept_before) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [actor, reason, a.member_id, b.member_id, moved, JSON.stringify(keptBefore)])).rows[0].id;
  await audit(c, actor, "member.merge", "member", a.member_id, { kept: a, merged: b }, { merged: b.member_id, rowsMoved: moved.length, altEmails: [...alts], mergeId: id }, reason);
  await audit(c, actor, "member.merged_into", "member", b.member_id, null, { into: a.member_id, mergeId: id }, reason);
  return { id };
}

async function undoMerge(c, mergeId, actor) {
  const m = (await c.query("SELECT * FROM merges WHERE id = $1 AND undone_at IS NULL FOR UPDATE", [mergeId])).rows[0];
  if (!m) return "That merge was already undone.";
  if ((await c.query("SELECT 1 FROM merges WHERE kept = $1 AND undone_at IS NULL AND id > $2", [m.merged, m.id])).rows[0]) return "Undo the later merge into this record first.";
  if (m.moved_ids.length) await c.query("UPDATE participation SET member_id = $1 WHERE id = ANY($2)", [m.merged, m.moved_ids]);
  const kb = m.kept_before || {};
  await c.query("UPDATE members SET alt_emails = $2, mobile = $3, first_seen = $4, full_name = $5, primary_email = $6, updated_at = now() WHERE member_id = $1",
    [m.kept, kb.alt_emails || null, kb.mobile || null, kb.first_seen || null, kb.full_name || "", kb.primary_email || null]);
  await c.query("UPDATE members SET merged_into = NULL, updated_at = now() WHERE member_id = $1", [m.merged]);
  await c.query("UPDATE merges SET undone_at = now() WHERE id = $1", [m.id]);
  const [x, y] = pair(m.kept, m.merged);
  await c.query("INSERT INTO dupe_dismissed (a, b, actor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [x, y, actor]); // don't merge these again automatically
  await audit(c, actor, "member.unmerge", "member", m.kept, null, { separated: m.merged, mergeId: m.id }, "Merge undone");
  return null;
}

/** Groups of live members that look like the same person. */
async function findGroups(c) {
  const members = (await (c || pool).query("SELECT member_id, full_name, primary_email, alt_emails, mobile, first_seen FROM members WHERE merged_into IS NULL")).rows;
  const dismissed = new Set((await (c || pool).query("SELECT a, b FROM dupe_dismissed")).rows.map((r) => r.a + "|" + r.b));
  const notDismissed = (g) => { for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (!dismissed.has(pair(g[i].member_id, g[j].member_id).join("|"))) return true; return false; };
  const byId = new Map(members.map((m) => [m.member_id, m]));
  const group = (keyFn) => {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const seen = new Map();
    for (const m of members) {
      parent.set(m.member_id, m.member_id);
      for (const k of keyFn(m)) { if (seen.has(k)) parent.set(find(m.member_id), find(seen.get(k))); else seen.set(k, m.member_id); }
    }
    const out = new Map();
    for (const m of members) { const r = find(m.member_id); if (!out.has(r)) out.set(r, []); out.get(r).push(byId.get(m.member_id)); }
    return [...out.values()].filter((g) => g.length > 1 && notDismissed(g)).map((g) => g.sort(oldestFirst));
  };
  const email = group(emailsOf);
  const inEmail = new Set(email.flat().map((m) => m.member_id));
  const phone = group((m) => { const p = R.normPhone(m.mobile); return p.length >= 9 ? [p] : []; }).filter((g) => g.some((m) => !inEmail.has(m.member_id)));
  const name = group((m) => { const n = nameKey(m.full_name); return n ? [n] : []; }).filter((g) => g.some((m) => !inEmail.has(m.member_id)));
  return { email, phone, name };
}

/** Same email = same person: merge every such group into its oldest record. */
async function autoMergeEmails(actor) {
  return tx(async (c) => {
    const { email } = await findGroups(c);
    let merged = 0;
    for (const g of email) {
      const keep = g[0];
      for (const other of g.slice(1)) {
        const [x, y] = pair(keep.member_id, other.member_id);
        if ((await c.query("SELECT 1 FROM dupe_dismissed WHERE a = $1 AND b = $2", [x, y])).rows[0]) continue;
        const r = await mergeMembers(c, keep.member_id, other.member_id, actor, "Same email address (automatic)");
        if (r.id) merged++;
      }
    }
    return merged;
  });
}

/** Extra facts per member for telling records apart: activity count, last activity, community, where the record came from. */
async function memberFacts(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(`SELECT m.member_id, m.community, m.gender, m.sources, m.alt_emails,
      count(p.id) FILTER (WHERE p.record_type <> 'Member Registration')::int AS n, max(p.record_date) FILTER (WHERE p.record_type <> 'Member Registration') AS last
    FROM members m LEFT JOIN participation p ON p.member_id = m.member_id AND p.voided_at IS NULL WHERE m.member_id = ANY($1) GROUP BY m.member_id`, [ids]);
  return new Map(r.rows.map((x) => [x.member_id, x]));
}

module.exports = function routes(app, { need, page, setFlash, actor, wrap }) {
  const A = need("admin");
  const contact = (m, show) => show
    ? `${h(m.primary_email || "no email")}${m.alt_emails ? ` <span class="muted">(also ${h(m.alt_emails)})</span>` : ""} · ${h(m.mobile || "no phone")}`
    : `${h(R.maskEmail(m.primary_email) || "no email")} · ${h(R.maskPhone(m.mobile) || "no phone")}`;
  const groupHtml = (g, kind, facts, show) => `<div class="card" style="padding:12px 14px;display:grid;gap:8px">
    <form method="post" action="/admin/duplicates/merge" class="form" style="gap:8px">
      <div class="tw"><table><thead><tr><th>Keep</th><th>Member ID</th><th>Name</th><th>Email · phone</th><th>Community</th><th>First seen</th><th class="n">Activities</th><th>Last activity</th><th>Came from</th></tr></thead><tbody>
      ${g.map((m, i) => { const f = facts.get(m.member_id) || {}; return `<tr><td><input type="radio" name="keep" value="${h(m.member_id)}" ${i === 0 ? "checked" : ""} aria-label="Keep ${h(m.member_id)}" style="width:20px;height:20px"></td>
        <td><a href="/members/${encodeURIComponent(m.member_id)}"><b>${h(m.member_id)}</b></a></td><td>${h(m.full_name)}</td><td style="overflow-wrap:anywhere">${contact({ ...m, alt_emails: f.alt_emails }, show)}</td>
        <td>${h([f.community, f.gender].filter(Boolean).join(" · ") || "—")}</td><td>${fmtDate(m.first_seen && String(m.first_seen).slice(0, 10))}</td><td class="n">${f.n || 0}</td>
        <td>${fmtDate(f.last && String(f.last).slice(0, 10))}</td><td class="muted" style="font-size:13px">${h(f.sources || "—")}</td></tr>`; }).join("")}</tbody></table></div>
      <input type="hidden" name="ids" value="${h(g.map((m) => m.member_id).join(","))}">
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Merge into the ticked record</button>
        <button class="btn" formaction="/admin/duplicates/dismiss">Not the same person</button></div>
      <p class="hint" style="margin:0">${kind === "phone" ? "Same phone number. A parent or friend may have registered several people with one number." : "Same name (word order, capitals and accents ignored). Check the email and phone before merging."}</p>
    </form></div>`;

  app.get("/admin/duplicates", A, wrap(async (req, res) => {
    const g = await findGroups();
    const recent = (await pool.query("SELECT * FROM merges ORDER BY id DESC LIMIT 40")).rows;
    const show = req.query.contact === "show";
    if (show) await audit(pool, actor(req), "member.contact_view", "duplicates", null, null, null, "Viewed contact details on the duplicates page");
    const facts = await memberFacts([...g.phone, ...g.name].flat().map((m) => m.member_id));
    res.send(page(req, "Duplicates", `
      <section class="card"><h2>Duplicate members</h2>
        <p class="lead">One person should have one member record. Records with the same email address are merged automatically into the oldest record.
        Records that only share a phone number or a name are listed below for you to decide. Merged Member IDs and their QR codes keep working.</p>
        <p style="margin:0 0 10px">${show ? `Full emails and phone numbers are showing (this view is logged). <a href="/admin/duplicates">Hide them</a>` : `Emails and phone numbers are partly hidden. <a href="?contact=show">Show full contact details</a> to compare them (logged in the audit log).`}</p>
        ${g.email.length ? `<form method="post" action="/admin/duplicates/auto"><button class="btn primary">Merge ${g.email.length} same-email group${g.email.length > 1 ? "s" : ""} now</button></form>` : `<p><span class="badge good">No same-email duplicates</span></p>`}
      </section>
      <section class="card"><h2>Same phone number <span class="badge">${g.phone.length}</span></h2><div style="display:grid;gap:10px;margin-top:10px">${g.phone.map((x) => groupHtml(x, "phone", facts, show)).join("") || `<p class="muted">Nothing to review.</p>`}</div></section>
      <section class="card"><h2>Same name <span class="badge">${g.name.length}</span></h2><div style="display:grid;gap:10px;margin-top:10px">${g.name.map((x) => groupHtml(x, "name", facts, show)).join("") || `<p class="muted">Nothing to review.</p>`}</div></section>
      <section class="card"><h2>Recent merges</h2><div class="tw"><table><thead><tr><th>When</th><th>Kept</th><th>Merged</th><th>Why</th><th></th></tr></thead><tbody>
        ${recent.map((m) => `<tr ${m.undone_at ? 'style="opacity:.55"' : ""}><td>${fmtDate(new Date(m.at).toISOString().slice(0, 10))}</td><td><a href="/members/${encodeURIComponent(m.kept)}">${h(m.kept)}</a></td><td>${h(m.merged)}</td><td>${h(m.reason || "")}</td>
          <td>${m.undone_at ? "Undone" : `<form method="post" action="/admin/duplicates/undo/${m.id}"><button class="btn tblbtn">Undo</button></form>`}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No merges yet.</td></tr>`}
      </tbody></table></div></section>`, { active: "/admin" }));
  }));
  app.post("/admin/duplicates/auto", A, wrap(async (req, res) => {
    const n = await autoMergeEmails(actor(req));
    setFlash(req, "ok", `Merged ${n} duplicate record${n === 1 ? "" : "s"}.`);
    res.redirect("/admin/duplicates");
  }));
  app.post("/admin/duplicates/merge", A, wrap(async (req, res) => {
    const ids = String(req.body.ids || "").split(",").filter(Boolean), keep = req.body.keep;
    if (!ids.includes(keep)) { setFlash(req, "err", "Tick the record to keep."); return res.redirect("/admin/duplicates"); }
    const err = await tx(async (c) => {
      for (const id of ids) if (id !== keep) { const r = await mergeMembers(c, keep, id, actor(req), "Reviewed duplicate"); if (r.err) throw Object.assign(new Error(r.err), { expose: true }); }
      return null;
    }).catch((e) => { if (e.expose) return e.message; throw e; });
    setFlash(req, err ? "err" : "ok", err || `Merged into ${keep}.`);
    res.redirect("/admin/duplicates");
  }));
  app.post("/admin/duplicates/dismiss", A, wrap(async (req, res) => {
    const ids = String(req.body.ids || "").split(",").filter(Boolean);
    await tx(async (c) => {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const [x, y] = pair(ids[i], ids[j]); await c.query("INSERT INTO dupe_dismissed (a, b, actor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [x, y, actor(req)]); }
      await audit(c, actor(req), "member.not_duplicate", "member", ids[0], null, { ids }, "Marked as different people");
    });
    setFlash(req, "ok", "Marked as different people.");
    res.redirect("/admin/duplicates");
  }));
  app.post("/admin/duplicates/undo/:id", A, wrap(async (req, res) => {
    const err = await tx((c) => undoMerge(c, +req.params.id, actor(req)));
    setFlash(req, err ? "err" : "ok", err || "Merge undone. The two records are separate again.");
    res.redirect("/admin/duplicates");
  }));
};
module.exports.mergeMembers = mergeMembers;
module.exports.undoMerge = undoMerge;
module.exports.findGroups = findGroups;
module.exports.nameKey = nameKey;
module.exports.autoMergeEmails = autoMergeEmails;
