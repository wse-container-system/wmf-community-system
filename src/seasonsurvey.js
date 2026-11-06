"use strict";
/**
 * End-of-season surveys (summer and winter): one standard set of questions so seasons compare,
 * a public form to send to the whole community, past surveys imported from Microsoft Forms exports,
 * and a comparison that shows what people keep asking for.
 */
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const multer = require("multer");
const QR = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate, nf } = require("./views");

// ---------------------------------------------------------------- the standard survey
const DEFAULTS = {
  Winter: {
    activities: ["Training Camp", "Monthly Mountain Rides", "Themed Rides (Halloween / Festive / UAE Tour)", "Community Challenge (Ramadan 30x30, UAE Tour Passport)", "Gran Fondo Training Plan",
      "Monthly Birthday Breakfast at Colnago Caffè", "Sustainability Jersey Initiative", "AUH – DXB – AUH Ride", "Community Iftar"],
    rides: ["Monday Madness", "Wednesday Socials", "Friday Morning Ride (YMC)", "Saturday Long Ride"],
  },
  Summer: {
    activities: ["Fan Zone during major cycling races", "International Yoga Day", "Emirati Women's Day", "End-of-Season Gathering", "Beat the Heat Strava Challenge", "Summer Workshops", "Monthly Birthday Ride & Breakfast"],
    rides: ["Monday Tempo Ride", "Tuesday MyWhoosh Indoor Ride", "Wednesday Cruise & Core Ride", "Friday Morning Ride (YMC)", "Sunday Ride"],
  },
};
const SCALE = ["Excellent", "Good", "Neutral", "Poor", "Didn't join"];
const SCALE_SCORE = { excellent: 5, "very good": 5, good: 4, neutral: 3, average: 3, poor: 2, "very poor": 1,
  "very satisfied": 5, "somewhat satisfied": 4, "neither satisfied nor dissatisfied": 3, "somewhat dissatisfied": 2, "very dissatisfied": 1 };
const OPEN = /suggest|feedback|explain|elaborate|why\b|improvements? would you like|highlight|comment|please use|what new|motivated you|which part|which stage/i;
const BARRIERS = ["Timing didn't work for me", "Location", "Work or family", "Weather / heat", "Pace or level of the ride", "Didn't know about it", "Away / travelling", "Injury or health"];

/** The questions of a new survey. ids are stable so every season compares. */
function standardQuestions(season, cfg) {
  const s = season.toLowerCase();
  return [
    { id: "tenure", q: "How long have you been riding with the WMF community?", type: "choice", options: ["Less than 1 year", "1–2 years", "3+ years"] },
    { id: "age", q: "What is your age group?", type: "choice", options: ["Under 18", "18–25", "26–35", "36–45", "46–60", "60+"] },
    { id: "city", q: "Where do you usually ride with WMF?", type: "choice", options: ["Abu Dhabi", "Dubai", "Both"] },
    { id: "freq", q: `How often did you join WMF rides or events this ${s}?`, type: "choice", options: ["Weekly", "2–3 times per month", "Occasionally", "I didn't attend but followed updates"] },
    ...cfg.activities.map((a, i) => ({ id: "act" + i, q: a, group: `How was each ${s} activity?`, type: "scale", options: SCALE })),
    { id: "rides", q: `Which WMF weekly rides did you enjoy the most this ${s}?`, type: "multi", options: cfg.rides },
    { id: "barriers", q: "If you missed some rides or activities, what held you back?", type: "multi", options: BARRIERS, other: true },
    { id: "again", q: `Which of these would you like to see again next ${s}?`, type: "multi", options: cfg.activities },
    { id: "org", q: "How satisfied are you with WMF organisation this season?", type: "rating" },
    { id: "coach_rel", q: "Coaches' relationship with the community (support, motivation, inclusivity)", type: "rating" },
    { id: "coach_teach", q: "Coaches' teaching ability (skills development, clarity, guidance)", type: "rating" },
    { id: "ideas", q: `What new activities or improvements would you like to see next ${s}?`, type: "text" },
    { id: "highlight", q: `What was your personal highlight of this ${s}?`, type: "text" },
    { id: "feedback", q: "Anything else? Suggestions, improvements and general feedback.", type: "text" },
  ];
}

// ---------------------------------------------------------------- reading answers (app and imported alike)
const clean = (s) => String(s == null ? "" : s).replace(/[ ]/g, " ").replace(/[​‌‍﻿]/g, "").replace(/\s+/g, " ").trim();
const NOT_JOINED = /^(didn.?t (join|participate)|did not (join|participate)|n\/?a)$/i;
const asList = (v) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(";")).map(clean).filter(Boolean);
function scoreOf(q, v) {
  const t = clean(v).toLowerCase();
  if (!t || NOT_JOINED.test(t)) return null;
  if (q.type === "rating") { const n = Number(t); return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null; }
  if (q.type === "rating10") { const n = Number(t); return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null; } // 0 is how the old export shows a skipped answer
  return SCALE_SCORE[t] ?? null;
}
/** Work out each question's type from its answers (imports only). */
function inferType(header, values) {
  const vals = values.map(clean).filter(Boolean).filter((v) => !NOT_JOINED.test(v));
  if (!vals.length || OPEN.test(header)) return "text";
  if (vals.every((v) => /^[1-5]$/.test(v))) return "rating";
  if (vals.every((v) => /^(10|[0-9])$/.test(v))) return "rating10";
  if (vals.every((v) => SCALE_SCORE[v.toLowerCase()] != null)) return "scale";
  if (values.some((v) => String(v || "").includes(";"))) return "multi";
  const distinct = new Set(vals);
  const avgLen = vals.reduce((a, v) => a + v.length, 0) / vals.length;
  if (avgLen > 45) return "text";
  return distinct.size <= 12 && (distinct.size < vals.length * 0.8 || avgLen < 25) ? "choice" : "text";
}

/** Summary per question: averages for ratings, counts for choices, quotes for text. */
function summarise(questions, rows) {
  return questions.map((q) => {
    const vals = rows.map((r) => r.answers[q.id]).filter((v) => v != null && !(Array.isArray(v) && !v.length) && clean(v) !== "");
    const out = { ...q, n: vals.length };
    if (q.type === "rating" || q.type === "rating10" || q.type === "scale") {
      const sc = vals.map((v) => scoreOf(q, v)).filter((x) => x != null);
      out.avg = sc.length ? sc.reduce((a, x) => a + x, 0) / sc.length : null;
      out.rated = sc.length; out.notJoined = vals.length - sc.length;
      out.max = q.type === "rating10" ? 10 : 5;
    } else if (q.type === "text") {
      out.quotes = vals.map(clean).filter((v) => v.length > 2 && !/^(n\/?a|na|no|none|nope|-|\.+)$/i.test(v));
    } else {
      const c = new Map();
      for (const v of vals) for (const p of asList(v)) c.set(p, (c.get(p) || 0) + 1);
      out.counts = [...c.entries()].sort((a, b) => b[1] - a[1]);
    }
    return out;
  });
}

// ---------------------------------------------------------------- themes: what people keep asking for
const THEMES = [
  ["Ride times & timetable", /timing|timetable|schedul|earlier|later start|start (at|time)|morning|evening|sunrise|after ?noon|weekday|weekend ride|another day|more rides|additional ride/i],
  ["Pace groups & levels", /level|pace|beginner|intermediate|middle|weaker|slower|less strong|split|abilit|dropped|left alone|neglect|keep up|groups? for|faster riders|strong rider/i],
  ["Training camps & trips", /camp|trip|overseas|liwa|oman|al ain|overnight|weekends? away|outside abu dhabi|other places around/i],
  ["Workshops & learning", /workshop|educat|learn|maintenance|teach|knowledge|tyre|tire|nutrition|recovery|handling|how to/i],
  ["New routes & longer rides", /wathba|qudra|route|longer|distance|location|mountain|jebel|jais|hafeet|different places|further/i],
  ["Indoor & summer options", /indoor|zwift|mywhoosh|spin|heat|pool|summer ride/i],
  ["Social & combined rides", /social|breakfast|gathering|connect|combined|joint|together|dubai.*(abu dhabi|auh)|(abu dhabi|auh).*dubai|both groups/i],
  ["Safety & ride etiquette", /safe|signal|headphone|etiquette|straight line|briefing|peloton|basics/i],
  ["Communication & reliability", /communicat|updates|cancel|left hanging|last minute|informed|instagram|whatsapp/i],
  ["Kit, perks & partners", /kit|jersey|shirt|discount|merch/i],
];
const ASKS = /reason|held you back|prevented|more of|improve|suggest|new activit|feedback|explain|elaborate|timetable|comment/i;
/** Share of respondents raising each theme in their asks, suggestions and reasons. */
function themesOf(questions, rows) {
  const qs = questions.filter((q) => q.type !== "rating" && q.type !== "rating10" && q.type !== "scale" && ASKS.test(q.q));
  return THEMES.map(([name, re]) => {
    const who = rows.filter((r) => qs.some((q) => asList(r.answers[q.id]).some((t) => re.test(t))));
    const quotes = rows.flatMap((r) => qs.filter((q) => q.type === "text").map((q) => clean(r.answers[q.id]))).filter((t) => t.length > 12 && re.test(t));
    return { name, n: who.length, share: rows.length ? who.length / rows.length : 0, quotes };
  });
}
/** Headline figures that every season has (matched on the wording, so older surveys count too). */
function kpis(questions, rows) {
  const S = summarise(questions, rows);
  const find = (re, types) => S.find((q) => re.test(q.q) && (!types || types.includes(q.type)));
  const avg = (re) => { const q = find(re, ["rating", "scale"]); return q && q.avg != null ? q.avg : null; };
  const top = (re) => { const q = find(re, ["multi", "choice"]); return q && q.counts && q.counts.length ? q.counts.slice(0, 3) : []; };
  const freq = find(/how (often|frequently)/i, ["choice", "multi"]);
  const weekly = freq && freq.n ? freq.counts.filter(([k]) => /weekly|per week|twice|3x/i.test(k)).reduce((a, [, n]) => a + n, 0) / freq.n : null;
  const isItem = (q) => q.type === "scale" || (q.type === "rating" && ((q.group && /how (satisfied|was)/i.test(q.group)) || (!q.group && !/[?]/.test(q.q) && !/organi[sz]ation|coach/i.test(q.q) && q.q.length < 80)));
  const acts = S.filter((q) => isItem(q) && q.rated >= 2 && !/title missing|^unnamed/i.test(q.q)).map((q) => ({ name: q.q, avg: q.avg, joined: q.rated, n: q.n })).sort((a, b) => b.joined - a.joined);
  let again = top(/see .*again|like to see more|see more of/i);
  if (!again.length) { // older form: one Yes / No question per item, grouped under "see again?"
    const yesNo = (q) => q.counts && q.counts.length && q.counts.every(([k]) => /^(yes|no)$/i.test(k));
    again = S.filter((q) => yesNo(q) && ((q.group && /again/i.test(q.group)) || (!q.group && !/[?]/.test(q.q)))).map((q) => [q.q, (q.counts.find(([k]) => /^yes/i.test(k)) || [, 0])[1]]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  }
  return {
    responses: rows.length, org: avg(/satisf.*organi[sz]ation/i), coachRel: avg(/relationship with the community/i), coachTeach: avg(/teaching ability/i), weekly,
    barriers: top(/held you back|reason|prevented/i), again, rides: top(/rides? did you (enjoy|join)|types of rides|enjoy the most/i), acts,
  };
}

// ---------------------------------------------------------------- importing a Microsoft Forms export
const META = /^(id|start time|completion time|email|name|last modified time|email ad+ress|please follow.*|would you like to receive promotional.*)$/i;
/** The first sheet as rows of plain values (row 0 = headings). Uses a small built-in reader when the Excel library can't open the file. */
async function sheetRows(buffer) {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = [...wb.worksheets].sort((a, b) => b.actualRowCount - a.actualRowCount)[0]; // the tab with the data
    if (!ws) throw new Error("no sheet");
    const cellv = (v) => (v && typeof v === "object" && !(v instanceof Date) ? ("result" in v ? v.result : v.richText ? v.richText.map((x) => x.text).join("") : v.text != null ? v.text : null) : v);
    const out = [];
    for (let r = 1; r <= ws.rowCount; r++) { const a = []; ws.getRow(r).eachCell({ includeEmpty: true }, (c, i) => { a[i - 1] = cellv(c.value); }); out.push(a); }
    return out;
  } catch (e) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buffer).catch(() => { throw new Error("This isn't an Excel (.xlsx) file."); });
    const read = async (n) => (zip.file(n) ? zip.file(n).async("string") : "");
    const un = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16))).replace(/&amp;/g, "&");
    const texts = (x) => [...x.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => un(m[1])).join("");
    const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => texts(m[1]));
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const sizes = await Promise.all(sheets.map(async (n) => (await read(n)).length));
    const sheetName = sheets[sizes.indexOf(Math.max(...sizes))];
    if (!sheetName) throw new Error("The file has no sheet.");
    const xml = await read(sheetName), out = [];
    const colNo = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b[^>]*?r="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const a = [];
      for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = cm[1], body = cm[2] || "", ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1], t = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        if (!ref) continue;
        const v = (/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body) || [])[1];
        a[colNo(ref)] = t === "s" ? shared[+v] : t === "inlineStr" ? texts(body) : t === "str" || t === "b" ? (v == null ? null : un(v)) : v == null ? null : Number(v);
      }
      out[+rm[1] - 1] = a;
    }
    return out.map((r) => r || []);
  }
}
const serialDate = (v) => (typeof v === "number" && v > 30000 && v < 80000 ? new Date(Math.round((v - 25569) * 864e5)).toISOString().replace(/\.\d+Z$/, "") : v);

async function parseFormsExport(buffer, { from } = {}) {
  const grid = await sheetRows(buffer);
  const heads = (grid[0] || []).map((x) => clean(x));
  const startCol = heads.findIndex((x) => /^start time$/i.test(x || "")), idCol = heads.findIndex((x) => /^id$/i.test(x || ""));
  if (startCol < 0 && idCol < 0) throw new Error("This doesn't look like a Microsoft Forms export (no ID or Start time column).");
  const cols = [];
  heads.forEach((t, i) => { if (t && !META.test(t)) cols.push(i); });
  const raw = [];
  for (const row of grid.slice(1)) {
    const id = idCol >= 0 ? row[idCol] : null, st = startCol >= 0 ? serialDate(row[startCol]) : null;
    if ((id == null || id === "") && (st == null || st === "")) continue; // totals and notes under the table
    const at = st instanceof Date ? st.toISOString() : st ? String(st) : null;
    if (from && (!at || String(at).slice(0, 10) < from)) continue; // a reused form: only this season's answers
    raw.push({ at, vals: cols.map((c) => { const v = row[c]; return v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? "" : String(v); }) });
  }
  if (!raw.length) throw new Error("No answers found in the file.");
  // grid questions come out as "Question?.Item" or "Question (1 = …).Item"
  const questions = cols.map((c, j) => {
    let t = heads[c], group = null;
    const m = /^(.*[?)])\s*\.(.+)$/.exec(t);
    if (m) { group = clean(m[1]); t = clean(m[2]); }
    t = t.replace(/([?.)a-z])\d$/i, "$1").replace(/^(column|\d+)$/i, `Unnamed question (column ${j + 1})`);
    const type = inferType(t, raw.map((x) => x.vals[j]));
    return { id: "c" + j, q: t, group, type };
  });
  const rows = raw.map((x) => ({ at: x.at, answers: Object.fromEntries(questions.map((q, j) => [q.id, q.type === "multi" ? asList(x.vals[j]) : clean(x.vals[j])]).filter(([, v]) => v && (!Array.isArray(v) || v.length))) }));
  return { questions, rows };
}

async function saveImported(c, { title, season, year, parsed, by, focus }) {
  const dates = parsed.rows.map((r) => String(r.at || "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const id = (await c.query(`INSERT INTO season_surveys (token, title, season, year, opened, source, open, questions, focus, created_by)
    VALUES ($1,$2,$3,$4,$5,'import',false,$6,$7,$8) RETURNING id`, [token(), title, season, year, dates[0] || null, JSON.stringify(parsed.questions), focus || null, by])).rows[0].id;
  for (const r of parsed.rows) await c.query("INSERT INTO season_answers (survey_id, answers, at) VALUES ($1,$2,$3)", [id, JSON.stringify(r.answers), r.at && !isNaN(Date.parse(r.at)) ? r.at : null]);
  await audit(c, by, "season_survey.import", "season_survey", String(id), null, { title, responses: parsed.rows.length });
  return id;
}
/** First start: load the past surveys the team shared (Nov 2026). Runs once. */
async function seed() {
  if ((await pool.query("SELECT 1 FROM settings WHERE key = 'seasonSurveysSeeded'")).rows[0]) return;
  const file = path.join(__dirname, "..", "data", "season-surveys-seed.json");
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  await tx(async (c) => {
    for (const s of data) await saveImported(c, { ...s, parsed: { questions: s.questions, rows: s.rows }, by: "system" });
    await c.query("INSERT INTO settings (key, value) VALUES ('seasonSurveysSeeded', $1)", [JSON.stringify({ at: new Date().toISOString(), surveys: data.length })]);
  });
}

const token = () => crypto.randomBytes(9).toString("base64url");
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const label = (s) => `${s.season === "Community" ? "Community" : s.season} ${s.year}`;
async function load(id) {
  const s = (await pool.query("SELECT * FROM season_surveys WHERE id = $1", [id])).rows[0];
  if (!s) return null;
  const rows = (await pool.query("SELECT answers, at FROM season_answers WHERE survey_id = $1 ORDER BY at NULLS LAST, id", [id])).rows;
  return { s, rows };
}
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const f1 = (x) => (x == null ? "—" : x.toFixed(1));

// ---------------------------------------------------------------- the survey shown in the reports
/** The survey picked for the reports, or else the latest end-of-season survey with enough answers. */
async function reportSurveyId() {
  const set = (await pool.query("SELECT value FROM settings WHERE key = 'reportSurvey'")).rows[0];
  if (set && +set.value) { const ok = (await pool.query("SELECT 1 FROM season_surveys WHERE id = $1", [+set.value])).rows[0]; if (ok) return +set.value; }
  const r = (await pool.query(`SELECT s.id FROM season_surveys s WHERE s.season IN ('Summer','Winter') AND (SELECT count(*) FROM season_answers a WHERE a.survey_id = s.id) >= 5
    ORDER BY s.year DESC, (s.season = 'Summer') DESC, s.id DESC LIMIT 1`)).rows[0];
  return r ? r.id : null;
}
/** A short, management-ready summary: answers, ratings, what they want, what holds them back, against the same season last year. */
async function reportSurvey() {
  const id = await reportSurveyId(); if (!id) return null;
  const { s, rows } = await load(id);
  const k = kpis(s.questions, rows);
  const themes = themesOf(s.questions, rows).filter((t) => t.n).sort((a, b) => b.n - a.n);
  const best = k.acts.filter((a) => a.avg != null && a.joined >= 3).sort((a, b) => b.avg - a.avg || b.joined - a.joined)[0] || null;
  const prevS = (await pool.query("SELECT id FROM season_surveys WHERE season = $1 AND year = $2 ORDER BY id DESC LIMIT 1", [s.season, s.year - 1])).rows[0];
  let prev = null;
  if (prevS) { const p = await load(prevS.id); const pk = kpis(p.s.questions, p.rows); prev = { label: label(p.s), responses: pk.responses, org: pk.org }; }
  const quote = themes.flatMap((t) => t.quotes).find((q) => q.length > 30 && q.length < 220) || null;
  return { id, title: s.title, label: label(s), season: s.season, year: s.year, focus: s.focus || "", responses: k.responses, org: k.org, coach: k.coachRel, weekly: k.weekly,
    asks: themes.slice(0, 3).map((t) => ({ name: t.name, n: t.n })), barrier: k.barriers[0] || null, again: k.again.slice(0, 3), best, prev, quote };
}
/** One line for the one-page report. */
const surveyLine = (S) => (S ? `${S.title}: ${S.responses} answers · organisation ${f1(S.org)}/5 · coaches ${f1(S.coach)}/5${S.asks[0] ? ` · top ask: ${S.asks[0].name.toLowerCase()}` : ""}` : "—");
/** The card for the dashboards. */
function surveyHtml(S) {
  if (!S) return '<p class="muted">No end-of-season survey yet.</p>';
  const d = S.prev && S.prev.org != null && S.org != null ? S.org - S.prev.org : null;
  return `<div class="mi-tot"><div><b>${nf(S.responses)}</b><span>answers</span></div><div><b>${f1(S.org)}<small>/5</small></b><span>organisation${d != null ? ` · ${Math.abs(d) < 0.05 ? "same as" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)} vs`} ${h(S.prev.label)}` : ""}</span></div>
      <div><b>${f1(S.coach)}<small>/5</small></b><span>coaches</span></div>${S.weekly != null ? `<div><b>${pct(S.weekly)}</b><span>ride every week</span></div>` : ""}</div>
    <dl class="sv-dl">${S.best ? `<dt>Best rated</dt><dd>${h(S.best.name)} (${f1(S.best.avg)}/5 from ${S.best.joined})</dd>` : ""}
      ${S.again.length ? `<dt>Most wanted again</dt><dd>${S.again.map(([k, n]) => `${h(k)} (${n})`).join(" · ")}</dd>` : ""}
      ${S.asks.length ? `<dt>What they ask for</dt><dd>${S.asks.map((a) => `${h(a.name)} (${a.n})`).join(" · ")}</dd>` : ""}
      ${S.barrier ? `<dt>What holds them back</dt><dd>${h(S.barrier[0])} (${S.barrier[1]} of ${S.responses})</dd>` : ""}
      ${S.focus ? `<dt>Our focus</dt><dd>${h(S.focus)}</dd>` : ""}</dl>
    ${S.quote ? `<p class="mk-impact">“${h(S.quote)}”</p>` : ""}`;
}

// ---------------------------------------------------------------- pages
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

function resultsHtml(questions, rows) {
  const S = summarise(questions, rows);
  let lastGroup = null;
  const block = (q) => {
    let head = "";
    if (q.group && q.group !== lastGroup) head = `<h3 class="ss-group">${h(q.group)}</h3>`;
    lastGroup = q.group || null;
    if (!q.n) return head;
    if (q.avg !== undefined) {
      const w = q.avg == null ? 0 : (q.avg / q.max) * 100;
      return `${head}<div class="hbar ss-r"><span class="hbar-l">${h(q.q)}</span><span class="hbar-t"><span style="width:${w}%;background:var(--s3)"></span></span>
        <span class="hbar-v"><b>${f1(q.avg)}</b><span class="muted"> / ${q.max}${q.notJoined ? ` · ${q.rated} joined` : ` · ${q.rated}`}</span></span></div>`;
    }
    if (q.counts) {
      const max = Math.max(1, ...q.counts.map((x) => x[1]));
      return `${head}<div class="ss-q"><h4>${h(q.q)} <span class="muted">${q.n} answers</span></h4>${q.counts.slice(0, 8).map(([k, n]) =>
        `<div class="hbar"><span class="hbar-l">${h(k)}</span><span class="hbar-t"><span style="width:${(n / max) * 100}%;background:var(--s1)"></span></span><span class="hbar-v">${n}</span></div>`).join("")}
        ${q.counts.length > 8 ? `<details><summary class="muted">${q.counts.length - 8} more</summary><p class="muted">${q.counts.slice(8).map(([k, n]) => `${h(k)} (${n})`).join(" · ")}</p></details>` : ""}</div>`;
    }
    return `${head}<div class="ss-q"><h4>${h(q.q)} <span class="muted">${q.quotes.length} comments</span></h4><ul class="quotes">${q.quotes.slice(0, 5).map((t) => `<li>${h(t)}</li>`).join("")}</ul>
      ${q.quotes.length > 5 ? `<details><summary class="muted">Show all ${q.quotes.length}</summary><ul class="quotes">${q.quotes.slice(5).map((t) => `<li>${h(t)}</li>`).join("")}</ul></details>` : ""}</div>`;
  };
  return S.map(block).join("");
}

module.exports = function seasonSurveys(app, { need, page, setFlash, actor, wrap, limit }) {
  const STAFF = need("admin", "coordinator");

  // ----- list + compare + where to focus
  app.get("/surveys/seasons", STAFF, wrap(async (req, res) => {
    const list = (await pool.query("SELECT s.*, (SELECT count(*)::int FROM season_answers a WHERE a.survey_id = s.id) AS n FROM season_surveys s ORDER BY coalesce(s.opened, s.created_at::date), s.id")).rows;
    const all = [];
    for (const s of list) { const rows = (await pool.query("SELECT answers FROM season_answers WHERE survey_id = $1", [s.id])).rows; all.push({ s, k: kpis(s.questions, rows), t: themesOf(s.questions, rows) }); }
    const done = all.filter((x) => x.k.responses >= 5); // a handful of answers is too few to read trends from
    const latest = [...done].reverse().find((x) => x.s.season !== "Community") || done[done.length - 1];
    const cell = (v) => `<td class="n">${v}</td>`;
    const recurring = THEMES.map(([name], i) => ({ name, per: done.map((x) => x.t[i].share), total: done.reduce((a, x) => a + x.t[i].n, 0) }))
      .map((t) => ({ ...t, seasons: t.per.filter((p) => p >= 0.1).length })).sort((a, b) => b.seasons - a.seasons || b.total - a.total);
    const heat = (p) => `<td class="n ss-heat" style="--a:${Math.min(1, p * 2.2).toFixed(2)}">${p ? Math.round(p * 100) + "%" : "·"}</td>`;
    // where to focus: from the latest season, plus what keeps coming back
    const focus = [];
    if (latest) {
      const lk = latest.k;
      if (lk.barriers[0]) focus.push(`<b>What stops people:</b> “${h(lk.barriers[0][0])}” (${lk.barriers[0][1]} of ${lk.responses})${lk.barriers[1] ? `, then “${h(lk.barriers[1][0])}”` : ""}.`);
      const lowJoin = lk.acts.filter((a) => a.n).sort((a, b) => a.joined / a.n - b.joined / b.n)[0];
      if (lowJoin) focus.push(`<b>Least joined:</b> ${h(lowJoin.name)}: ${lowJoin.joined} of ${lowJoin.n} took part${lowJoin.avg ? `, rated ${f1(lowJoin.avg)} by them` : ""}. Promote it more, or rethink it.`);
      const best = lk.acts.filter((a) => a.avg != null && a.joined >= 3).sort((a, b) => b.avg - a.avg || b.joined - a.joined)[0];
      if (best) focus.push(`<b>Strongest:</b> ${h(best.name)} (${f1(best.avg)} / 5 from ${best.joined}). Keep it.`);
      if (lk.again[0]) focus.push(`<b>Most wanted again:</b> ${lk.again.map(([k, n]) => `${h(k)} (${n})`).join(", ")}.`);
    }
    for (const t of recurring.filter((x) => x.seasons >= 3).slice(0, 3)) focus.push(`<b>Keeps coming up:</b> ${h(t.name)}, raised in ${t.seasons} of ${done.length} surveys.`);
    res.send(page(req, "Season surveys", `<div class="grid">
      <section class="card c8"><div class="card-head"><div><h2>End-of-season surveys</h2><p class="lead">One survey at the end of each summer and winter, the same core questions every time, so you can see what changes.</p></div>
        <a class="btn primary" href="/surveys/seasons/new">New end-of-season survey</a></div>
        <div class="tw"><table><thead><tr><th>Survey</th><th class="n">Answers</th><th class="n">Organisation</th><th class="n">Coaches</th><th class="n">Ride weekly</th><th>Top reason for missing out</th></tr></thead><tbody>
        ${[...all].reverse().map(({ s, k }) => `<tr><td><a href="/surveys/seasons/${s.id}"><b>${h(s.title)}</b></a><br><span class="muted">${s.opened ? fmtDate(s.opened) : ""}${s.source === "import" ? " · imported" : s.open ? " · open" : " · closed"}</span></td>
          ${cell(nf(k.responses))}${cell(f1(k.org))}${cell(k.coachRel != null || k.coachTeach != null ? f1([k.coachRel, k.coachTeach].filter((x) => x != null).reduce((a, x, _, arr) => a + x / arr.length, 0)) : "—")}${cell(pct(k.weekly))}
          <td>${k.barriers[0] ? h(k.barriers[0][0]) : '<span class="muted">—</span>'}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No surveys yet.</td></tr>`}</tbody></table></div>
        <p class="hint">Organisation and coaches are averages out of 5. The early community surveys used other questions, so some columns are empty for them.</p></section>
      <section class="card c4"><h2>Where to focus</h2><p class="lead">From ${latest ? h(latest.s.title) : "the latest survey"} and what keeps coming back.</p>
        <ul class="ss-focus">${focus.map((x) => `<li>${x}</li>`).join("") || '<li class="muted">Answers will show here.</li>'}</ul>
        <form method="get" action="/surveys/seasons/import"><button class="btn">Import a past survey (Excel)</button></form></section>
      <section class="card c12"><h2>What people keep asking for</h2><p class="lead">Share of people who raised each topic in their reasons, suggestions and feedback. The darker the cell, the more people asked.</p>
        <div class="tw"><table class="ss-themes"><thead><tr><th>Topic</th>${done.map((x) => `<th class="n">${h(label(x.s))}</th>`).join("")}</tr></thead><tbody>
        ${recurring.map((t) => `<tr><td>${h(t.name)}</td>${t.per.map(heat).join("")}</tr>`).join("")}</tbody></table></div>
        <details style="margin-top:8px"><summary><b>What they said, by topic (latest survey)</b></summary>${latest ? latest.t.filter((t) => t.quotes.length).map((t) => `<h4 style="margin:10px 0 4px">${h(t.name)}</h4><ul class="quotes">${t.quotes.slice(0, 4).map((x) => `<li>${h(x)}</li>`).join("")}</ul>`).join("") : ""}</details></section>
    </div>`, { active: "/surveys" }));
  }));

  // ----- create a new one
  app.get("/surveys/seasons/new", STAFF, (req, res) => {
    const m = +R.todayLocal().slice(5, 7), season = m >= 4 && m <= 9 ? "Winter" : "Summer"; // a survey sent in Oct is about the summer just gone
    const y = +R.todayLocal().slice(0, 4);
    const d = DEFAULTS;
    res.send(page(req, "New season survey", `<section class="card"><h2>New end-of-season survey</h2>
      <p class="lead">The questions are the same every season (how often, rate each activity, what held you back, organisation, coaches, highlight, ideas). You only list this season's activities and weekly rides.</p>
      <form class="form" method="post" action="/surveys/seasons/new">
        <div class="row2"><label>Season<select name="season" id="ssSeason">${["Summer", "Winter"].map((s) => `<option ${s === season ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label>Year<input type="number" name="year" min="2024" max="2100" value="${y}" required></label></div>
        <label>Activities and events this season <span class="hint">(one per line: each is rated, and asked “see again?”)</span>
          <textarea name="activities" rows="9" data-winter="${h(d.Winter.activities.join("\n"))}" data-summer="${h(d.Summer.activities.join("\n"))}">${h(d[season].activities.join("\n"))}</textarea></label>
        <label>Weekly rides this season <span class="hint">(one per line)</span>
          <textarea name="rides" rows="5" data-winter="${h(d.Winter.rides.join("\n"))}" data-summer="${h(d.Summer.rides.join("\n"))}">${h(d[season].rides.join("\n"))}</textarea></label>
        <p class="hint" style="margin:0">Changing the season fills in last ${h(season === "Winter" ? "winter's" : "summer's")} lists; edit them to match this season.</p>
        <button class="btn primary">Create the survey</button></form></section>`, { active: "/surveys", wide: false, scripts: `<script src="/seasonsurvey.js"></script>` }));
  });
  app.post("/surveys/seasons/new", STAFF, wrap(async (req, res) => {
    const b = req.body || {};
    const season = ["Summer", "Winter"].includes(b.season) ? b.season : "Winter", year = Math.min(2100, Math.max(2024, +b.year || +R.todayLocal().slice(0, 4)));
    const lines = (v) => [...new Set(String(v || "").split(/\r?\n/).map(clean).filter(Boolean))].slice(0, 20);
    const cfg = { activities: lines(b.activities), rides: lines(b.rides) };
    if (!cfg.activities.length) { setFlash(req, "err", "List at least one activity."); return res.redirect("/surveys/seasons/new"); }
    const title = `End of ${season} Season Survey ${year}`;
    const id = await tx(async (c) => {
      const sid = (await c.query(`INSERT INTO season_surveys (token, title, season, year, opened, source, open, questions, created_by) VALUES ($1,$2,$3,$4,$5,'app',true,$6,$7) RETURNING id`,
        [token(), title, season, year, R.todayLocal(), JSON.stringify(standardQuestions(season, cfg)), actor(req)])).rows[0].id;
      await audit(c, actor(req), "season_survey.create", "season_survey", String(sid), null, { title, ...cfg });
      return sid;
    });
    setFlash(req, "ok", "Survey ready. Send the link below.");
    res.redirect("/surveys/seasons/" + id);
  }));

  // ----- import a past one
  app.get("/surveys/seasons/import", STAFF, (req, res) => res.send(page(req, "Import survey", `<section class="card"><h2>Import a past survey</h2>
    <p class="lead">Upload the Excel file from Microsoft Forms (Responses → Open in Excel → download). Names and email addresses in the file are not kept.</p>
    <form class="form" method="post" action="/surveys/seasons/import" enctype="multipart/form-data">
      <div class="row2"><label>Season<select name="season"><option>Summer</option><option>Winter</option><option value="Community">Community (whole year)</option></select></label>
        <label>Year<input type="number" name="year" min="2020" max="2100" value="${R.todayLocal().slice(0, 4)}" required></label></div>
      <label>Title<input name="title" maxlength="120" placeholder="e.g. End of Summer Season Survey 2026" required></label>
      <label>Only answers from <span class="hint">(optional: if the same form was reused, the date this season's survey went out)</span><input type="date" name="from"></label>
      <input type="file" name="file" accept=".xlsx" required><button class="btn primary">Import</button></form></section>`, { active: "/surveys", wide: false })));
  app.post("/surveys/seasons/import", STAFF, upload.single("file"), wrap(async (req, res) => {
    const b = req.body || {};
    if (!req.file) return res.redirect("/surveys/seasons/import");
    let parsed;
    try { parsed = await parseFormsExport(req.file.buffer, { from: /^\d{4}-\d{2}-\d{2}$/.test(b.from || "") ? b.from : undefined }); } catch (e) { setFlash(req, "err", "Couldn't read that file: " + e.message); return res.redirect("/surveys/seasons/import"); }
    const season = ["Summer", "Winter", "Community"].includes(b.season) ? b.season : "Community";
    const id = await tx((c) => saveImported(c, { title: clean(b.title).slice(0, 120) || `${season} survey ${b.year}`, season, year: +b.year || +R.todayLocal().slice(0, 4), parsed, by: actor(req) }));
    setFlash(req, "ok", `Imported ${parsed.rows.length} answers.`);
    res.redirect("/surveys/seasons/" + id);
  }));

  // ----- one survey: send + results + our focus
  app.get("/surveys/seasons/:id", STAFF, wrap(async (req, res) => {
    const x = await load(+req.params.id || 0);
    if (!x) return res.redirect("/surveys/seasons");
    const { s, rows } = x;
    const k = kpis(s.questions, rows);
    const link = `${baseOf(req)}/fs/${s.token}`;
    let send = "";
    if (s.source === "app") {
      const qr = await QR.toDataURL(link, { margin: 1, width: 320 });
      const msg = `Hi WMF ladies! The ${s.season.toLowerCase()} season is a wrap 🚴‍♀️ Please tell us how it went, it takes about 3 minutes and helps us plan next ${s.season.toLowerCase()}: ${link}`;
      const since = (await pool.query("SELECT (current_date - 200)::text AS d")).rows[0].d;
      const emails = (await pool.query(`SELECT DISTINCT lower(m.primary_email) AS e FROM members m WHERE m.merged_into IS NULL AND m.updates_consent = 'Yes' AND m.primary_email LIKE '%@%'
        AND EXISTS (SELECT 1 FROM participation p WHERE p.member_id = m.member_id AND p.voided_at IS NULL AND p.record_date >= $1::date) ORDER BY 1`, [since])).rows.map((r) => r.e);
      send = `<section class="card c5"><h2>Send it</h2>
        <div class="sc-row"><input class="inp" value="${h(link)}" readonly aria-label="Survey link"><button class="btn" type="button" data-copy="${h(link)}">Copy</button></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
          <a class="btn primary" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Post in the WhatsApp community</a>
          <a class="btn" href="${qr}" download="season-survey-QR.png">QR code</a>
          ${emails.length ? `<button class="btn" type="button" data-copy="${h(emails.join(", "))}">Copy ${emails.length} emails</button>` : ""}</div>
        <details><summary class="muted">Message text</summary><p style="white-space:pre-line">${h(msg)}</p><button class="btn tblbtn" type="button" data-copy="${h(msg)}">Copy message</button></details>
        <p class="hint">${emails.length ? `The emails are members who rode in the last six months and agreed to updates. Paste them into BCC.` : ""} Show the QR code at the last rides of the season too.</p>
        <form method="post" action="/surveys/seasons/${s.id}/toggle" style="margin-top:8px"><button class="btn">${s.open ? "Close the survey" : "Open it again"}</button></form></section>`;
    }
    res.send(page(req, s.title, `<div class="grid">
      <section class="card ${send ? "c7" : "c12"}"><div class="card-head"><div><h2>${h(s.title)}</h2><p class="lead">${s.source === "import" ? "Imported" : s.open ? "Open for answers" : "Closed"}${s.opened ? " · " + fmtDate(s.opened) : ""} · <a href="/surveys/seasons">All seasons</a></p></div>
          ${(await reportSurveyId()) === s.id ? '<span class="badge good">Shown in the reports</span>' : `<form method="post" action="/surveys/seasons/${s.id}/report" style="margin:0"><button class="btn tblbtn">Show in the reports</button></form>`}</div>
        <div class="tiles"><div class="tile"><span class="lbl">Answers</span><span class="val">${nf(k.responses)}</span></div>
          <div class="tile"><span class="lbl">Organisation</span><span class="val">${f1(k.org)}</span><span class="note">out of 5</span></div>
          <div class="tile"><span class="lbl">Coaches</span><span class="val">${f1(k.coachRel)}</span><span class="note">relationship${k.coachTeach != null ? ` · teaching ${f1(k.coachTeach)}` : ""}</span></div>
          <div class="tile"><span class="lbl">Ride weekly</span><span class="val">${pct(k.weekly)}</span></div></div>
        <form class="form" method="post" action="/surveys/seasons/${s.id}/focus" style="margin-top:12px"><label><b>Our focus from this survey</b> <span class="hint">(the actions you take from it: goes into the comparison)</span>
          <textarea name="focus" rows="3" maxlength="1500">${h(s.focus)}</textarea></label><button class="btn">Save</button></form></section>
      ${send}
      <section class="card c12"><h2>Results</h2>${rows.length ? resultsHtml(s.questions, rows) : '<p class="muted">No answers yet.</p>'}
        ${s.source === "import" ? `<form method="post" action="/surveys/seasons/${s.id}/delete" style="margin-top:14px"><button class="btn danger" data-confirm="Delete this imported survey?">Delete this import</button></form>` : ""}</section></div>`, { active: "/surveys" }));
  }));
  app.post("/surveys/seasons/:id/report", STAFF, wrap(async (req, res) => {
    const id = +req.params.id || 0;
    await pool.query("INSERT INTO settings (key, value) VALUES ('reportSurvey', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(id)]);
    setFlash(req, "ok", "This survey now shows in the management and performance reports."); res.redirect("/surveys/seasons/" + id);
  }));
  app.post("/surveys/seasons/:id/toggle", STAFF, wrap(async (req, res) => { await pool.query("UPDATE season_surveys SET open = NOT open WHERE id = $1 AND source = 'app'", [+req.params.id || 0]); res.redirect("/surveys/seasons/" + (+req.params.id || "")); }));
  app.post("/surveys/seasons/:id/focus", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE season_surveys SET focus = $2 WHERE id = $1", [+req.params.id || 0, String(req.body.focus || "").replace(/\r/g, "").trim().slice(0, 1500) || null]);
    setFlash(req, "ok", "Saved."); res.redirect("/surveys/seasons/" + (+req.params.id || ""));
  }));
  app.post("/surveys/seasons/:id/delete", STAFF, wrap(async (req, res) => {
    await tx(async (c) => { const s = (await c.query("DELETE FROM season_surveys WHERE id = $1 AND source = 'import' RETURNING id, title", [+req.params.id || 0])).rows[0]; if (s) await audit(c, actor(req), "season_survey.delete", "season_survey", String(s.id), s, null); });
    setFlash(req, "ok", "Deleted."); res.redirect("/surveys/seasons");
  }));

  // ----- public form
  const byToken = async (t) => (await pool.query("SELECT * FROM season_surveys WHERE token = $1 AND source = 'app'", [String(t || "").slice(0, 40)])).rows[0];
  const field = (q) => {
    const name = `q_${q.id}`;
    if (q.type === "choice") return `<fieldset class="rate"><legend>${h(q.q)}</legend><div class="rate-row">${q.options.map((o) => `<label><input type="radio" name="${name}" value="${h(o)}"><span>${h(o)}</span></label>`).join("")}</div></fieldset>`;
    if (q.type === "multi") return `<fieldset class="rate"><legend>${h(q.q)} <span class="hint">(choose any)</span></legend><div class="ss-checks">${q.options.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${h(o)}"> <span>${h(o)}</span></label>`).join("")}
      ${q.other ? `<label>Other<input name="${name}_other" maxlength="120"></label>` : ""}</div></fieldset>`;
    if (q.type === "rating") return `<fieldset class="rate"><legend>${h(q.q)}</legend><div class="rate-row">${[1, 2, 3, 4, 5].map((k) => `<label><input type="radio" name="${name}" value="${k}"><span>${k}</span></label>`).join("")}</div><div class="rate-ends"><span>Poor</span><span>Excellent</span></div></fieldset>`;
    if (q.type === "scale") return `<div class="ss-grow"><span>${h(q.q)}</span><div class="rate-row sm">${q.options.map((o) => `<label><input type="radio" name="${name}" value="${h(o)}"><span>${h(o)}</span></label>`).join("")}</div></div>`;
    return `<label>${h(q.q)}<textarea name="${name}" rows="3" maxlength="800"></textarea></label>`;
  };
  function formHtml(s, err) {
    let lastGroup = null;
    const body = s.questions.map((q) => {
      let pre = "";
      if (q.group !== lastGroup) { if (lastGroup) pre += "</fieldset>"; if (q.group) pre += `<fieldset class="rate ss-gridset"><legend>${h(q.group)}</legend>`; lastGroup = q.group || null; }
      return pre + field(q);
    }).join("") + (lastGroup ? "</fieldset>" : "");
    return `<section class="card"><h2>${h(s.title)}</h2><p class="lead">Thank you for riding with WMN Moving FWD this ${h(s.season.toLowerCase())}. About 3 minutes. Every question is optional, and your answers are anonymous.</p>
      ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
      <form class="form" method="post">${body}
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <button class="btn primary big">Send</button></form></section>`;
  }
  app.get("/fs/:token", wrap(async (req, res) => {
    const s = await byToken(req.params.token);
    if (!s || !s.open) return res.status(404).send(page(req, "Survey", `<section class="card"><h2>This survey is closed</h2><p class="lead">Thank you. See what's coming up on the <a href="/calendar">WMF calendar</a>.</p></section>`, { wide: false }));
    res.send(page(req, s.title, formHtml(s), { wide: false }));
  }));
  app.post("/fs/:token", limit("seasonsurvey", 15, 60 * 60e3), wrap(async (req, res) => {
    const s = await byToken(req.params.token), b = req.body || {};
    if (!s || !s.open) return res.redirect("/fs/" + encodeURIComponent(req.params.token));
    if (b.website) return res.redirect("/calendar");
    const answers = {};
    for (const q of s.questions) {
      const v = b[`q_${q.id}`];
      if (q.type === "multi") {
        const list = (Array.isArray(v) ? v : v ? [v] : []).filter((x) => q.options.includes(x));
        const other = clean(b[`q_${q.id}_other`]).slice(0, 120);
        if (other) list.push(other);
        if (list.length) answers[q.id] = list;
      } else if (q.type === "choice" || q.type === "scale") { if (q.options.includes(v)) answers[q.id] = v; }
      else if (q.type === "rating") { if (/^[1-5]$/.test(String(v))) answers[q.id] = String(v); }
      else { const t = String(v || "").replace(/\r/g, "").trim().slice(0, 800); if (t) answers[q.id] = t; }
    }
    if (!Object.keys(answers).length) return res.send(page(req, s.title, formHtml(s, "Please answer at least one question."), { wide: false }));
    await pool.query("INSERT INTO season_answers (survey_id, answers, at) VALUES ($1, $2, now())", [s.id, JSON.stringify(answers)]);
    res.send(page(req, "Thank you", `<section class="card" style="display:grid;gap:10px"><h2>Thank you!</h2><p class="lead">Your answers go straight to the WMF team and shape next ${h(s.season.toLowerCase())}.</p>
      <p><a class="btn primary" href="/calendar">See upcoming rides and events</a></p></section>`, { wide: false }));
  }));
};
module.exports.parseFormsExport = parseFormsExport;
module.exports.sheetRows = sheetRows;
module.exports.summarise = summarise;
module.exports.kpis = kpis;
module.exports.themesOf = themesOf;
module.exports.seed = seed;
module.exports.reportSurvey = reportSurvey;
module.exports.surveyHtml = surveyHtml;
module.exports.surveyLine = surveyLine;
module.exports.standardQuestions = standardQuestions;
module.exports.DEFAULTS = DEFAULTS;
