"use strict";
/**
 * WMF activations: events, campaigns, workshops and partner events, with participation, partners and impact.
 * History comes from the "WMF Activation" workbook (one sheet per year); new ones are added in the app.
 */
const ExcelJS = require("exceljs");
const multer = require("multer");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate } = require("./views");

const CATEGORIES = ["WMF Major Events", "Themed Community Rides", "Mountain & Monthly Rides", "Workshops", "Campaigns & Challenges",
  "Partner & Collaborated Events", "Grand Tour Activations", "Community Gatherings", "Training Plans", "Other Activations"];
const STATUSES = ["Completed", "Planned", "Cancelled"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ---------- cleaning the workbook's free text ----------
const CAT_MAP = {
  "wmf major event": "WMF Major Events", "themed community rides": "Themed Community Rides", "community ride": "Themed Community Rides", "wmf event": "Themed Community Rides",
  "monthly wmf community rides": "Mountain & Monthly Rides", "wmf general & technical workshops": "Workshops", "workshop": "Workshops",
  "campaign": "Campaigns & Challenges", "community challenge": "Campaigns & Challenges", "themed challenge": "Campaigns & Challenges",
  "collaborated event": "Partner & Collaborated Events", "collab event": "Partner & Collaborated Events", "wmf - sponsor support": "Partner & Collaborated Events",
  "grand tour activations": "Grand Tour Activations", "post-ride and birthday breakfasts": "Community Gatherings", "community gathering": "Community Gatherings",
  "community activation": "Community Gatherings", "training plan": "Training Plans", "summer activation": "Other Activations", "running activatio": "Other Activations",
  "running activation": "Other Activations", "yalla let's ride": "Other Activations", "marketing event": "Other Activations",
};
function categoryOf(raw, title) {
  const c = R.clean(raw).toLowerCase(), t = R.clean(title).toLowerCase();
  if (CAT_MAP[c]) return CAT_MAP[c];
  if (/training camp|women'?s day race|international women/.test(t)) return "WMF Major Events";
  if (/workshop/.test(t)) return "Workshops";
  if (/mountain|shawka|jebel/.test(t)) return "Mountain & Monthly Rides";
  if (/challenge|campaign/.test(t)) return "Campaigns & Challenges";
  if (/tour de france|giro|vuelta/.test(t)) return "Grand Tour Activations";
  if (/breakfast|brunch|viewing|friendship|sisters|day/.test(t)) return "Community Gatherings";
  if (/ride/.test(t)) return "Themed Community Rides";
  return "Other Activations";
}
const PARTNER_ALIASES = {
  "colnago caffe": "Colnago Caffè", "colnago caffè": "Colnago Caffè", "colnago": "Colnago Caffè", "colnago community": "Colnago Community",
  "wolfis": "Wolfi's", "wolfies": "Wolfi's", "wolfi's": "Wolfi's", "wolfi’s": "Wolfi's", "wolfi’s bike shop": "Wolfi's", "wolfi's bike shop": "Wolfi's", "wolfis cycling academy": "Wolfi's",
  "hpc": "HPC (High Performance)", "high performance": "HPC (High Performance)", "mywhoosh": "MyWhoosh", "ultrahuman": "Ultrahuman", "lululemon": "Lululemon",
  "adrt": "ADRT", "adcc": "Abu Dhabi Cycling Club (ADCC)", "abu dhabi cycling club (adcc)": "Abu Dhabi Cycling Club (ADCC)", "abu dhabi cycling club": "Abu Dhabi Cycling Club (ADCC)",
  "nyu": "NYU", "fcsh": "FCHS", "fchs": "FCHS", "321 sports": "321 Sports", "modon": "Modon", "clymb": "CLYMB", "the service course": "The Service Course",
  "liwa hotel": "Liwa Hotel", "western liwa hotel": "Liwa Hotel", "foh": "Festival of Health (FOH)", "adphc": "ADPHC", "gritncode": "Grit n Code", "grit n code": "Grit n Code",
  "on": "On", "soul & wellness": "Soul & Wellness", "rm hub studio": "RM Hub Studio", "wtms": "WTMS", "fab": "FAB", "vita 1": "Vita 1", "pediasure": "PediaSure",
  "seba med": "Seba Med", "one health medical center": "One Health Medical Center", "pocari sweat": "Pocari Sweat", "burjeel hospital": "Burjeel Hospital",
  "marsana": "Marsana", "bab al nojum": "Bab Al Nojum",
};
const NOT_PARTNERS = new Set(["", "none", "wmf", "-", "n/a", "na"]);
function partnersOf(raw, title, categoryRaw) {
  let s = String(raw == null ? "" : raw).replace(/\([^)]*\)/g, (m) => (/adcc/i.test(m) ? m : "")).replace(/soul\s*&\s*wellness/gi, "soul__and__wellness");
  const out = new Set();
  for (let p of s.split(/,|&|\band\b|\/|\n/i)) {
    p = R.clean(p.replace(/soul__and__wellness/g, "soul & wellness")).replace(/[.,;:]+$/, "");
    const k = p.toLowerCase();
    if (NOT_PARTNERS.has(k)) continue;
    out.add(PARTNER_ALIASES[k] || p.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  // 2024 "sponsor support" rows name the partner in the title only
  if (!out.size && /sponsor/i.test(categoryRaw || "")) {
    const t = R.clean(title).toLowerCase();
    for (const [k, v] of [["fab", "FAB"], ["modon", "Modon"], ["adcc", "Abu Dhabi Cycling Club (ADCC)"], ["gran fondo", "Abu Dhabi Gran Fondo"], ["l'etape", "L'Étape Dubai"]]) if (t.includes(k)) out.add(v);
  }
  return [...out];
}
function monthOf(v, year) {
  if (v instanceof Date) return v.toISOString().slice(0, 7) + "-01";
  const s = R.clean(v).toLowerCase();
  const i = MONTHS.findIndex((m) => s.startsWith(m) || s.startsWith(m.slice(0, 3)));
  const y = (s.match(/(20\d\d)/) || [])[1] || year;
  return i >= 0 && y ? `${y}-${String(i + 1).padStart(2, "0")}-01` : null;
}
const cellv = (v) => (v && typeof v === "object" && !(v instanceof Date) ? ("result" in v ? v.result : v.richText ? v.richText.map((x) => x.text).join("") : v.text != null ? v.text : null) : v);
const num = (v) => { v = cellv(v); const n = Number(String(v == null ? "" : v).replace(/[^\d.]/g, "")); return v != null && v !== "" && Number.isFinite(n) && String(v).match(/\d/) ? Math.round(n) : null; };

/** Read every sheet that has an "Activations" header. Nothing is written. */
async function parseActivationWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [], warnings = [];
  for (const ws of wb.worksheets) {
    const year = (ws.name.match(/(20\d\d)/) || [])[1];
    let headerRow = null, cols = {};
    for (let r = 1; r <= 8 && !headerRow; r++) {
      const row = ws.getRow(r);
      row.eachCell((c, i) => { const t = R.clean(cellv(c.value)).toLowerCase(); if (t === "activations") headerRow = r; });
      if (headerRow) row.eachCell((c, i) => { cols[R.clean(cellv(c.value)).toLowerCase()] = i; });
    }
    if (!headerRow || !year) continue;
    const collabCol = cols["collaborations"];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r), g = (k) => (cols[k] ? cellv(row.getCell(cols[k]).value) : null);
      const title = R.clean(g("activations"));
      if (!title) continue;
      const catRaw = R.clean(g("category"));
      const month = monthOf(g("month"), year);
      if (!month) { warnings.push(`${ws.name} row ${r}: no month for “${title}”, skipped.`); continue; }
      const dateCell = g("date");
      const impact = R.clean(String(g("impact") == null ? "" : g("impact")).replace(/\r/g, "")) ? String(g("impact")).replace(/\r/g, "").trim() : null;
      // the 2026 sheet has an unnamed column after Collaborations holding links or photo notes
      const extra = collabCol && !Object.values(cols).includes(collabCol + 1) ? R.clean(cellv(row.getCell(collabCol + 1).value)) : "";
      const cancelled = /cancel/i.test(catRaw) || /^cancelled/i.test(impact || "");
      out.push({
        title, month, event_date: dateCell instanceof Date ? dateCell.toISOString().slice(0, 10) : null,
        date_note: dateCell && !(dateCell instanceof Date) ? R.clean(dateCell) : null,
        category: categoryOf(cancelled ? "" : catRaw, title), category_raw: catRaw || null, lead_owner: R.clean(g("lead owner")) || null,
        frequency: R.clean(g("frequency")) || null, participants: num(g("participants") != null ? g("participants") : g("numbers")),
        registrants: (() => { const m = /total\s+regist\w*\s*:?\s*(\d+)/i.exec(impact || ""); return m ? +m[1] : null; })(),
        impact, link: /^https?:\/\//i.test(extra) ? extra : null, status: cancelled ? "Cancelled" : month > R.todayLocal() ? "Planned" : "Completed",
        partners: partnersOf(collabCol ? cellv(row.getCell(collabCol).value) : "", title, catRaw), source: "import:" + ws.name,
        notes: extra && !/^https?:\/\//i.test(extra) ? extra : null,
      });
    }
  }
  if (!out.length) throw new Error("No activation sheets found. The sheets need a header row with “Activations”.");
  return { rows: out, warnings };
}

async function partnerId(c, name) {
  const n = R.clean(name);
  const ex = (await c.query("SELECT id FROM partners WHERE lower(name) = lower($1) OR lower($1) = ANY (SELECT lower(x) FROM unnest(aliases) x)", [n])).rows[0];
  if (ex) return ex.id;
  return (await c.query("INSERT INTO partners (name) VALUES ($1) RETURNING id", [n])).rows[0].id;
}
async function setPartners(c, activationId, names) {
  await c.query("DELETE FROM activation_partners WHERE activation_id = $1", [activationId]);
  for (const n of names) if (R.clean(n)) await c.query("INSERT INTO activation_partners VALUES ($1, $2) ON CONFLICT DO NOTHING", [activationId, await partnerId(c, n)]);
}
async function commitActivations(parsed, actor) {
  return tx(async (c) => {
    const removed = (await c.query("DELETE FROM activations WHERE source LIKE 'import:%'")).rowCount; // re-import replaces the imported history only
    for (const a of parsed.rows) {
      const { partners, notes, ...row } = a;
      if (notes) row.impact = row.impact ? row.impact + "\n\n" + notes : notes;
      const cols = Object.keys(row);
      const id = (await c.query(`INSERT INTO activations (${cols}) VALUES (${cols.map((_, i) => "$" + (i + 1))}) RETURNING id`, cols.map((k) => row[k]))).rows[0].id;
      await setPartners(c, id, partners);
    }
    await c.query("DELETE FROM partners p WHERE NOT EXISTS (SELECT 1 FROM activation_partners ap WHERE ap.partner_id = p.id) AND p.notes IS NULL");
    await audit(c, actor, "activations.import", "activations", null, null, { imported: parsed.rows.length, replaced: removed }, null);
    return { imported: parsed.rows.length, replaced: removed };
  });
}

/** Activations with their partners, for lists and reports. */
async function loadActivations(where = "TRUE", args = []) {
  return (await pool.query(`SELECT a.*, coalesce(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '{}') AS partners,
      (SELECT count(*) FROM participation x WHERE x.activity_id = a.activity_id AND x.voided_at IS NULL) AS app_signups
    FROM activations a LEFT JOIN activation_partners ap ON ap.activation_id = a.id LEFT JOIN partners p ON p.id = ap.partner_id
    WHERE ${where} GROUP BY a.id ORDER BY a.month DESC, a.event_date DESC NULLS LAST, a.id DESC`, args)).rows;
}

/**
 * An app event whose date has passed becomes an activation, with its sign-ups, who came, first-timers and partners.
 * While nobody has edited the activation, the counts keep following the sign-up list; after an edit only empty counts are filled.
 */
async function syncHeldEvents(actor = "system") {
  const today = R.todayLocal();
  const evs = (await pool.query(`SELECT a.*,
      (SELECT count(*) FROM participation p WHERE p.activity_id = a.activity_id AND p.voided_at IS NULL AND p.record_type = 'Event Registration')::int AS regs,
      (SELECT count(*) FROM participation p WHERE p.activity_id = a.activity_id AND p.voided_at IS NULL AND p.record_type = 'Event Registration' AND p.status = 'Attended')::int AS came,
      (SELECT count(*) FROM participation p WHERE p.activity_id = a.activity_id AND p.voided_at IS NULL AND p.record_type = 'Event Registration' AND p.member_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM participation q WHERE q.member_id = p.member_id AND q.voided_at IS NULL AND q.record_type IN ('Attendance', 'Event Registration')
          AND q.activity_id IS DISTINCT FROM p.activity_id AND q.record_date < p.record_date))::int AS fresh,
      x.id AS act_id, x.auto_sync, x.participants AS x_participants, x.registrants AS x_registrants, x.new_contacts AS x_new
    FROM activities a LEFT JOIN LATERAL (SELECT * FROM activations y WHERE y.activity_id = a.activity_id ORDER BY y.id LIMIT 1) x ON TRUE
    WHERE a.kind = 'event' AND a.status = 'Active' AND a.event_date IS NOT NULL AND a.event_date < $1::date`, [today])).rows;
  let created = 0;
  for (const e of evs) {
    const d = String(e.event_date).slice(0, 10);
    const counts = { registrants: e.regs || null, participants: e.came || null, new_contacts: e.fresh || null };
    if (!e.act_id) {
      await tx(async (c) => {
        const row = { title: e.name, month: d.slice(0, 7) + "-01", event_date: d, category: CATEGORIES.includes(e.category) ? e.category : "Themed Community Rides",
          location: e.location || null, status: "Completed", activity_id: e.activity_id, source: "event", auto_sync: true, link: e.strava_url || null, ...counts };
        const cols = Object.keys(row);
        const id = (await c.query(`INSERT INTO activations (${cols}) VALUES (${cols.map((_, i) => "$" + (i + 1))}) RETURNING id`, cols.map((k) => row[k]))).rows[0].id;
        await setPartners(c, id, String(e.partners || "").split(",").map(R.clean).filter(Boolean));
        await audit(c, actor, "activation.from_event", "activation", String(id), null, row, "Event date passed");
      });
      created++;
    } else {
      const keep = (k, cur) => (e.auto_sync ? counts[k] ?? cur : cur ?? counts[k]);
      const next = { registrants: keep("registrants", e.x_registrants), participants: keep("participants", e.x_participants), new_contacts: keep("new_contacts", e.x_new) };
      if (next.registrants !== e.x_registrants || next.participants !== e.x_participants || next.new_contacts !== e.x_new)
        await pool.query("UPDATE activations SET registrants = $2, participants = $3, new_contacts = $4, updated_at = now() WHERE id = $1", [e.act_id, next.registrants, next.participants, next.new_contacts]);
    }
  }
  return created;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const previews = new Map();

module.exports = function routes(app, { need, page, setFlash, actor, user, wrap }) {
  const STAFF = need("admin", "coordinator"), READ = need("admin", "coordinator", "viewer");
  const canEdit = (req) => ["admin", "coordinator"].includes(user(req).role);
  const monthLabel = (m) => { const d = String(m).slice(0, 7); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+d.slice(5, 7) - 1] + " " + d.slice(0, 4); };

  app.get("/activations", READ, wrap(async (req, res) => {
    await syncHeldEvents(actor(req));
    const years = (await pool.query("SELECT DISTINCT extract(year FROM month)::int y FROM activations ORDER BY y DESC")).rows.map((r) => r.y);
    const year = years.includes(+req.query.year) ? +req.query.year : req.query.year === "all" ? null : years[0] || null;
    const cat = CATEGORIES.includes(req.query.category) ? req.query.category : "";
    const partner = R.clean(req.query.partner);
    const where = [], args = [];
    if (year) { args.push(year); where.push(`extract(year FROM a.month) = $${args.length}`); }
    if (cat) { args.push(cat); where.push(`a.category = $${args.length}`); }
    if (partner) { args.push(partner); where.push(`EXISTS (SELECT 1 FROM activation_partners ap2 JOIN partners p2 ON p2.id = ap2.partner_id WHERE ap2.activation_id = a.id AND p2.name = $${args.length})`); }
    const rows = await loadActivations(where.join(" AND ") || "TRUE", args);
    const done = rows.filter((r) => r.status === "Completed");
    const people = done.reduce((s, r) => s + (r.participants || 0), 0);
    const withP = done.filter((r) => r.partners.length).length;
    const partners = (await pool.query("SELECT name FROM partners ORDER BY name")).rows.map((r) => r.name);
    res.send(page(req, "Events & activations", `
      <section class="card"><div class="card-head"><div><h2>WMF events & activations</h2><p class="lead">Every event, campaign, workshop and partner activation, with who took part, who WMF worked with and what it achieved.</p></div>
        ${canEdit(req) ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/partners">Partners</a><a class="btn primary" href="/activations/new">Add activation</a></div>` : `<a class="btn" href="/partners">Partners</a>`}</div>
        <form method="get" class="toolbar" style="margin:4px 0 12px">
          <select class="inp" name="year" style="width:auto"><option value="all">All years</option>${years.map((y) => `<option ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select>
          <select class="inp" name="category" style="width:auto"><option value="">All categories</option>${CATEGORIES.map((c) => `<option ${c === cat ? "selected" : ""}>${h(c)}</option>`).join("")}</select>
          <select class="inp" name="partner" style="width:auto"><option value="">All partners</option>${partners.map((p) => `<option ${p === partner ? "selected" : ""}>${h(p)}</option>`).join("")}</select>
          <button class="btn">Show</button></form>
        <div class="tiles" style="margin-bottom:14px">
          <div class="tile"><span class="lbl">Activations held</span><span class="val">${done.length}</span><span class="note">${rows.length - done.length ? rows.length - done.length + " planned or cancelled" : ""}</span></div>
          <div class="tile"><span class="lbl">Participants</span><span class="val">${people.toLocaleString("en-GB")}</span><span class="note">Total attendance</span></div>
          <div class="tile"><span class="lbl">With a partner</span><span class="val">${done.length ? Math.round((withP / done.length) * 100) : 0}%</span><span class="note">${withP} of ${done.length}</span></div>
          <div class="tile"><span class="lbl">Partners involved</span><span class="val">${new Set(done.flatMap((r) => r.partners)).size}</span></div>
        </div>
        <div class="tw"><table><thead><tr><th>When</th><th>Activation</th><th>Category</th><th>Partners</th><th class="n">Participants</th><th>Impact</th></tr></thead><tbody>
        ${rows.map((r) => `<tr ${r.status !== "Completed" ? 'style="opacity:.6"' : ""}><td style="white-space:nowrap">${r.event_date ? fmtDate(r.event_date) : monthLabel(r.month)}</td>
          <td><a href="/activations/${r.id}"><b>${h(r.title)}</b></a>${r.status !== "Completed" ? ` <span class="badge">${h(r.status)}</span>` : ""}</td><td>${h(r.category)}</td>
          <td>${r.partners.map((p) => `<span class="badge" style="margin:1px">${h(p)}</span>`).join("") || '<span class="muted">—</span>'}</td>
          <td class="n">${r.participants == null ? "—" : r.participants.toLocaleString("en-GB")}</td><td class="muted" style="font-size:13px;max-width:360px">${h((r.impact || "").slice(0, 140))}${(r.impact || "").length > 140 ? "…" : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No activations yet.${user(req).role === "admin" ? ' <a href="/admin/activations-import">Import the WMF Activation workbook</a>.' : ""}</td></tr>`}
        </tbody></table></div></section>`, { active: "/activations" }));
  }));

  async function form(req, a) {
    const evs = (await pool.query("SELECT activity_id, name, event_date FROM activities WHERE kind = 'event' ORDER BY event_date DESC NULLS LAST, name LIMIT 200")).rows;
    const partners = (await pool.query("SELECT name FROM partners ORDER BY name")).rows.map((r) => r.name);
    const ro = !canEdit(req) ? "disabled" : "";
    const sv = a.activity_id ? (await pool.query(`SELECT s.id, count(r.id)::int AS n, round(avg(r.rating), 1) AS avg FROM surveys s LEFT JOIN survey_responses r ON r.survey_id = s.id
      WHERE s.activity_id = $1 GROUP BY s.id ORDER BY s.id LIMIT 1`, [a.activity_id])).rows[0] : null;
    return `<section class="card"><h2>${a.id ? h(a.title) : "Add an activation"}</h2>
      ${a.auto_sync ? `<div class="alert info"><span class="ic">i</span><span>Created from the event when its date passed. Sign-ups, who came and first-timers update by themselves. Add the impact, aim and anything missing, then Save.</span></div>` : ""}
      ${sv ? `<p class="hint" style="margin:0 0 8px">Survey: <b>${sv.n}</b> answer${sv.n === 1 ? "" : "s"}${sv.avg ? ` · average <b>${sv.avg} / 5</b>` : ""} · <a href="/surveys/${sv.id}">See results</a></p>` : a.activity_id && canEdit(req) ? `<p class="hint" style="margin:0 0 8px"><a href="/surveys?event=${encodeURIComponent(a.activity_id)}">Send a follow-up survey for this event</a></p>` : ""}
      <form class="form" method="post" action="/activations/${a.id || "new"}">
        <label>Title<input name="title" required maxlength="160" value="${h(a.title)}" ${ro}></label>
        <div class="row2"><label>Month<input type="month" name="month" required value="${h(String(a.month || R.todayLocal()).slice(0, 7))}" ${ro}></label>
          <label>Exact date <span class="hint">(optional)</span><input type="date" name="event_date" value="${h(a.event_date || "")}" ${ro}></label></div>
        <div class="row2"><label>Category<select name="category" ${ro}>${CATEGORIES.map((c) => `<option ${a.category === c ? "selected" : ""}>${h(c)}</option>`).join("")}</select></label>
          <label>Status<select name="status" ${ro}>${STATUSES.map((s) => `<option ${a.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>
        <label>Partners / collaborations <span class="hint">(comma-separated, e.g. Colnago Caffè, Wolfi's)</span><input name="partners" list="partner-list" value="${h((a.partners || []).join(", "))}" ${ro}><datalist id="partner-list">${partners.map((p) => `<option value="${h(p)}">`).join("")}</datalist></label>
        <div class="row2"><label>Participants (attended)<input type="number" min="0" name="participants" value="${h(a.participants == null ? "" : a.participants)}" ${ro}></label>
          <label>Registrations <span class="hint">(optional)</span><input type="number" min="0" name="registrants" value="${h(a.registrants == null ? "" : a.registrants)}" ${ro}></label></div>
        <div class="row2"><label>New contacts <span class="hint">(people new to WMF)</span><input type="number" min="0" name="new_contacts" value="${h(a.new_contacts == null ? "" : a.new_contacts)}" ${ro}></label>
          <label>Aim <span class="hint">(why we ran it: one line)</span><input name="aim" maxlength="200" value="${h(a.aim)}" ${ro} placeholder="e.g. Reach a new community of women"></label></div>
        <div class="row2"><label>Lead<input name="lead_owner" maxlength="80" value="${h(a.lead_owner)}" ${ro}></label><label>Frequency<input name="frequency" maxlength="60" value="${h(a.frequency)}" ${ro} placeholder="one time event, monthly…"></label></div>
        <div class="row2"><label>Location<input name="location" maxlength="120" value="${h(a.location)}" ${ro}></label>
          <label>Linked app event <span class="hint">(sign-ups counted automatically)</span><select name="activity_id" ${ro}><option value="">None</option>${evs.map((e) => `<option value="${h(e.activity_id)}" ${a.activity_id === e.activity_id ? "selected" : ""}>${h(e.name)}${e.event_date ? " · " + fmtDate(e.event_date) : ""}</option>`).join("")}</select></label></div>
        ${a.activity_id ? `<p class="hint" style="margin:0">App sign-ups for the linked event: <b>${a.app_signups}</b> · <a href="/activities/${encodeURIComponent(a.activity_id)}/signups">See list</a></p>` : ""}
        <label>Impact <span class="hint">(what happened and what it achieved: highlights, first-timers, feedback, learnings)</span><textarea name="impact" rows="7" ${ro}>${h(a.impact)}</textarea></label>
        <label>Link <span class="hint">(photos, post, report)</span><input type="url" name="link" maxlength="400" value="${h(a.link)}" ${ro}></label>
        ${canEdit(req) ? `<div style="display:flex;gap:8px"><button class="btn primary">Save</button><a class="btn" href="/activations">Cancel</a></div>` : ""}
      </form>
      ${a.id && canEdit(req) ? `<form method="post" action="/activations/${a.id}/delete" style="margin-top:12px"><button class="btn danger">Delete</button></form>` : ""}</section>`;
  }
  app.get("/activations/new", STAFF, wrap(async (req, res) => res.send(page(req, "Add activation", await form(req, { status: "Completed", category: "Themed Community Rides" }), { active: "/activations", wide: false }))));
  app.get("/activations/:id", READ, wrap(async (req, res) => {
    const a = (await loadActivations("a.id = $1", [+req.params.id || 0]))[0];
    if (!a) return res.redirect("/activations");
    res.send(page(req, a.title, await form(req, a), { active: "/activations", wide: false }));
  }));
  app.post("/activations/:id", STAFF, wrap(async (req, res) => {
    const b = req.body, isNew = req.params.id === "new";
    const title = R.clean(b.title), month = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month + "-01" : null;
    if (!title || !month) { setFlash(req, "err", "Enter a title and month."); return res.redirect(isNew ? "/activations/new" : "/activations/" + +req.params.id); }
    if (b.link && !/^https?:\/\//i.test(b.link)) { setFlash(req, "err", "The link must start with https://"); return res.redirect(isNew ? "/activations/new" : "/activations/" + +req.params.id); }
    const n = (v) => (v === "" || v == null ? null : Math.max(0, Math.round(+v)) || 0);
    const row = { title, month, event_date: /^\d{4}-\d{2}-\d{2}$/.test(b.event_date || "") ? b.event_date : null, category: CATEGORIES.includes(b.category) ? b.category : "Other Activations",
      status: STATUSES.includes(b.status) ? b.status : "Completed", participants: n(b.participants), registrants: n(b.registrants), lead_owner: R.clean(b.lead_owner) || null,
      frequency: R.clean(b.frequency) || null, location: R.clean(b.location) || null, activity_id: R.clean(b.activity_id) || null,
      impact: String(b.impact || "").trim() || null, link: R.clean(b.link) || null, new_contacts: n(b.new_contacts), aim: R.clean(b.aim) || null, auto_sync: false };
    const partners = String(b.partners || "").split(",").map(R.clean).filter(Boolean);
    const id = await tx(async (c) => {
      let aid, before = null;
      const cols = Object.keys(row);
      if (isNew) aid = (await c.query(`INSERT INTO activations (${cols}, source) VALUES (${cols.map((_, i) => "$" + (i + 1))}, 'app') RETURNING id`, cols.map((k) => row[k]))).rows[0].id;
      else {
        before = (await c.query("SELECT * FROM activations WHERE id = $1 FOR UPDATE", [+req.params.id])).rows[0];
        if (!before) return null;
        aid = before.id;
        await c.query(`UPDATE activations SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [aid, ...cols.map((k) => row[k])]);
      }
      await setPartners(c, aid, partners);
      await audit(c, actor(req), isNew ? "activation.create" : "activation.update", "activation", String(aid), before, { ...row, partners });
      return aid;
    });
    setFlash(req, id ? "ok" : "err", id ? "Saved." : "Not found.");
    res.redirect(id ? "/activations/" + id : "/activations");
  }));
  app.post("/activations/:id/delete", STAFF, wrap(async (req, res) => {
    await tx(async (c) => {
      const a = (await c.query("DELETE FROM activations WHERE id = $1 RETURNING *", [+req.params.id])).rows[0];
      if (a) await audit(c, actor(req), "activation.delete", "activation", String(a.id), a, null);
    });
    setFlash(req, "ok", "Deleted.");
    res.redirect("/activations");
  }));

  // ---------- partners ----------
  app.get("/partners", READ, wrap(async (req, res) => {
    const r = (await pool.query(`SELECT p.*, count(a.id) FILTER (WHERE a.status = 'Completed') AS n, sum(a.participants) FILTER (WHERE a.status = 'Completed') AS people,
        min(a.month) AS first, max(a.month) AS last, array_agg(DISTINCT extract(year FROM a.month)::int) FILTER (WHERE a.id IS NOT NULL) AS years
      FROM partners p LEFT JOIN activation_partners ap ON ap.partner_id = p.id LEFT JOIN activations a ON a.id = ap.activation_id
      GROUP BY p.id ORDER BY count(a.id) DESC, p.name`)).rows;
    const names = r.map((p) => p.name);
    res.send(page(req, "Partners", `<section class="card"><div class="card-head"><div><h2>Partners & collaborations</h2><p class="lead">Everyone WMF has worked with, how often, and how many people those activations reached. ${canEdit(req) ? "Two names for the same partner? Merge them." : ""}</p></div><a class="btn" href="/activations">Activations</a></div>
      <div class="tw"><table><thead><tr><th>Partner</th><th class="n">Activations</th><th class="n">Participants reached</th><th>Years</th><th>Last worked with</th>${canEdit(req) ? "<th></th>" : ""}</tr></thead><tbody>
      ${r.map((p) => `<tr><td><a href="/activations?year=all&partner=${encodeURIComponent(p.name)}"><b>${h(p.name)}</b></a>${p.aliases.length ? `<br><span class="muted" style="font-size:12px">Also: ${h(p.aliases.join(", "))}</span>` : ""}</td>
        <td class="n">${p.n}</td><td class="n">${Number(p.people || 0).toLocaleString("en-GB")}</td><td>${h((p.years || []).sort().join(", "))}</td><td>${p.last ? monthLabel(p.last) : "—"}</td>
        ${canEdit(req) ? `<td><form method="post" action="/partners/${p.id}" class="toolbar" style="margin:0;align-items:center"><input class="inp" name="name" value="${h(p.name)}" style="max-width:180px;min-height:32px;font-size:13px">
          <select class="inp" name="merge_into" style="max-width:170px;min-height:32px;font-size:13px"><option value="">Rename only</option>${names.filter((x) => x !== p.name).map((x) => `<option>Merge into: ${h(x)}</option>`).join("")}</select><button class="btn tblbtn">Save</button></form></td>` : ""}</tr>`).join("") || `<tr><td colspan="6" class="muted">No partners yet.</td></tr>`}
      </tbody></table></div></section>`, { active: "/activations" }));
  }));
  app.post("/partners/:id", STAFF, wrap(async (req, res) => {
    const msg = await tx(async (c) => {
      const p = (await c.query("SELECT * FROM partners WHERE id = $1 FOR UPDATE", [+req.params.id])).rows[0];
      if (!p) return "Partner not found.";
      const into = String(req.body.merge_into || "").replace(/^Merge into: /, "");
      if (into) {
        const t = (await c.query("SELECT * FROM partners WHERE name = $1", [into])).rows[0];
        if (!t || t.id === p.id) return "Choose another partner.";
        await c.query("INSERT INTO activation_partners SELECT activation_id, $1 FROM activation_partners WHERE partner_id = $2 ON CONFLICT DO NOTHING", [t.id, p.id]);
        await c.query("UPDATE partners SET aliases = (SELECT array_agg(DISTINCT x) FROM unnest(aliases || $2::text[]) x) WHERE id = $1", [t.id, [p.name, ...p.aliases]]);
        await c.query("DELETE FROM partners WHERE id = $1", [p.id]);
        await audit(c, actor(req), "partner.merge", "partner", t.name, { merged: p.name }, { into: t.name }, null);
        return `Merged ${p.name} into ${t.name}.`;
      }
      const name = R.clean(req.body.name);
      if (!name || name === p.name) return "Nothing changed.";
      if ((await c.query("SELECT 1 FROM partners WHERE lower(name) = lower($1) AND id <> $2", [name, p.id])).rows[0]) return "That name exists already. Use Merge.";
      await c.query("UPDATE partners SET name = $2, aliases = array_append(aliases, $3) WHERE id = $1", [p.id, name, p.name]);
      await audit(c, actor(req), "partner.rename", "partner", name, { name: p.name }, { name }, null);
      return `Renamed to ${name}.`;
    });
    setFlash(req, /^(Merged|Renamed)/.test(msg) ? "ok" : "info", msg);
    res.redirect("/partners");
  }));

  // ---------- import (administrators) ----------
  const A = need("admin");
  app.get("/admin/activations-import", A, (req, res) => res.send(page(req, "Import activations", `<section class="card"><h2>Import the WMF Activation workbook</h2>
    <p class="lead">Reads every sheet with an “Activations” column (one sheet per year). Categories and partner names are tidied up; the preview shows the result before anything is saved. Importing again replaces the imported history, but keeps activations added in the app.</p>
    <form class="form" method="post" action="/admin/activations-import" enctype="multipart/form-data"><input type="file" name="file" accept=".xlsx" required><button class="btn primary">Read file and preview</button></form></section>`, { active: "/admin", wide: false })));
  app.post("/admin/activations-import", A, upload.single("file"), wrap(async (req, res) => {
    if (!req.file) return res.redirect("/admin/activations-import");
    let parsed;
    try { parsed = await parseActivationWorkbook(req.file.buffer); } catch (e) { setFlash(req, "err", "Couldn't read that file: " + e.message); return res.redirect("/admin/activations-import"); }
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60e3) previews.delete(k);
    const token = require("crypto").randomBytes(16).toString("hex");
    previews.set(token, { parsed, at: Date.now() });
    const byYear = {}, byCat = {}, partners = {};
    for (const a of parsed.rows) { const y = a.month.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; byCat[a.category] = (byCat[a.category] || 0) + 1; for (const p of a.partners) partners[p] = (partners[p] || 0) + 1; }
    res.send(page(req, "Import preview", `<section class="card"><h2>Preview</h2><p class="lead">Nothing has been saved yet.</p>
      <dl class="kv"><dt>Activations</dt><dd>${parsed.rows.length} (${Object.entries(byYear).map(([y, n]) => `${y}: ${n}`).join(", ")})</dd>
        <dt>Categories</dt><dd>${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${h(c)} ${n}`).join(" · ")}</dd>
        <dt>Partners found</dt><dd>${Object.entries(partners).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${h(p)} (${n})`).join(", ")}</dd></dl>
      ${parsed.warnings.length ? `<ul>${parsed.warnings.map((w) => `<li>${h(w)}</li>`).join("")}</ul>` : ""}
      <div class="tw" style="max-height:340px;overflow:auto;margin-top:10px"><table><thead><tr><th>Month</th><th>Activation</th><th>Category (was)</th><th>Partners</th><th class="n">Participants</th></tr></thead><tbody>
      ${parsed.rows.map((a) => `<tr><td>${monthLabel(a.month)}</td><td>${h(a.title)}${a.status !== "Completed" ? ` <span class="badge">${a.status}</span>` : ""}</td><td>${h(a.category)} <span class="muted">(${h(a.category_raw || "—")})</span></td><td>${h(a.partners.join(", "))}</td><td class="n">${a.participants ?? "—"}</td></tr>`).join("")}
      </tbody></table></div>
      <form method="post" action="/admin/activations-import/commit" style="margin-top:12px"><input type="hidden" name="token" value="${token}"><button class="btn primary big">Import ${parsed.rows.length} activations</button></form></section>`, { active: "/admin" }));
  }));
  app.post("/admin/activations-import/commit", A, wrap(async (req, res) => {
    const p = previews.get(String(req.body.token || ""));
    if (!p) { setFlash(req, "err", "The preview expired. Upload the file again."); return res.redirect("/admin/activations-import"); }
    const out = await commitActivations(p.parsed, actor(req));
    previews.delete(String(req.body.token));
    setFlash(req, "ok", `Imported ${out.imported} activations.`);
    res.redirect("/activations?year=all");
  }));
};
module.exports.parseActivationWorkbook = parseActivationWorkbook;
module.exports.commitActivations = commitActivations;
module.exports.loadActivations = loadActivations;
module.exports.CATEGORIES = CATEGORIES;
module.exports.syncHeldEvents = syncHeldEvents;
