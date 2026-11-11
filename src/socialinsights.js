"use strict";
/**
 * Social media insights, month by month: marketing uploads their monthly insights Excel (or types the figures in),
 * every row is kept for marketing, and the management report shows a compact, clickable summary.
 * Calculated figures (net followers, growth, interactions, rates) are always worked out here.
 */
const ExcelJS = require("exceljs");
const { pool, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { h, nf, monLabel, mini, detailTiles } = require("./views");
const { lines: lineChart } = require("./charts");

/** The template's rows. key → label, section, and the words that recognise the row in an uploaded file. */
const METRICS = [
  ["followers_start", "Followers at start of month", "Audience & discovery", /followers? at (the )?start/i],
  ["followers_end", "Followers at end of month", "Audience & discovery", /followers? at (the )?end/i],
  ["reach", "Accounts reached / unique viewers", "Audience & discovery", /accounts reached|unique viewers/i],
  ["nonfollower_reach", "Non-follower reach / viewers", "Audience & discovery", /non-?follower/i],
  ["views", "Total content views", "Audience & discovery", /total content views|^views$/i],
  ["profile_visits", "Profile visits", "Audience & discovery", /profile visits/i],
  ["link_clicks", "Profile link clicks", "Audience & discovery", /link clicks/i],
  ["published", "Content published (total)", "Content & engagement", /content published/i],
  ["reels", "Reels / videos published", "Content & engagement", /reels? \/ videos? published|videos published/i],
  ["feed_posts", "Feed photo / carousel posts", "Content & engagement", /feed photo|carousel posts/i],
  ["stories", "Stories published", "Content & engagement", /stories published/i],
  ["likes", "Likes", "Content & engagement", /^likes$/i],
  ["comments", "Comments", "Content & engagement", /^comments$/i],
  ["shares", "Shares", "Content & engagement", /^shares$/i],
  ["saves", "Saves / favorites", "Content & engagement", /^saves/i],
  ["video_views", "Video views (Reels / TikTok)", "Video performance", /^video views/i],
  ["avg_watch", "Average watch time (seconds)", "Video performance", /average watch time/i],
];
const NOTES = [
  ["top_url", "Top-performing post / video URL", /top-?performing post|post \/ video url/i],
  ["top_theme", "Top-performing content theme", /content theme/i],
  ["campaign", "Key event / collaboration", /key event|collaboration/i],
  ["campaign_views", "Campaign content views", /campaign content views/i],
  ["campaign_shares", "Campaign shares", /campaign shares/i],
  ["learning", "Key learning / action", /key learning|learning \/ action/i],
];
const PCOLOR = { instagram: "#d4537e", tiktok: "#444441", facebook: "#6250d6", youtube: "#e34948", linkedin: "#2a78d6", x: "#7a7a75", strava: "#eb6834" };
const colorOf = (p) => PCOLOR[String(p).toLowerCase().split(/[\s/]/)[0]] || "#9a988f";
const num = (v) => { if (v == null || v === "") return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const s = String(v).replace(/[,\s%]/g, ""); return /^-?\d+(\.\d+)?$/.test(s) ? +s : null; };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Calculated figures for one platform. */
function calc(m) {
  const o = { ...m };
  const parts = ["likes", "comments", "shares", "saves"].map((k) => m[k]).filter((v) => v != null);
  o.interactions = parts.length ? parts.reduce((s, v) => s + v, 0) : null;
  o.net = m.followers_end != null && m.followers_start != null ? m.followers_end - m.followers_start : null;
  o.growth = o.net != null && m.followers_start ? o.net / m.followers_start : null;
  o.eng_rate = o.interactions != null && m.views ? o.interactions / m.views : null;
  o.share_rate = m.shares != null && m.views ? m.shares / m.views : null;
  o.save_rate = m.saves != null && m.views ? m.saves / m.views : null;
  return o;
}

/** Read an uploaded insights file: the month from the title, one column per platform, and the notes rows. */
async function parseInsights(buffer) {
  const grid = await require("./seasonsurvey").sheetRows(buffer);
  const txt = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  const head = grid.findIndex((r) => r && /^metric$/i.test(txt(r[0])));
  if (head < 0) throw new Error("Couldn't find the METRIC heading row. Use the insights template (Download template).");
  const cols = []; (grid[head] || []).forEach((v, i) => { const t = txt(v); if (i > 0 && t && !/notes|source/i.test(t)) cols.push([i, t.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()).replace(/^Tiktok$/, "TikTok")]); });
  if (!cols.length) throw new Error("No platform columns (e.g. Instagram, TikTok) next to METRIC.");
  const platforms = Object.fromEntries(cols.map(([, p]) => [p, {}])), notes = {};
  for (const r of grid.slice(head + 1)) {
    const label = txt(r && r[0]); if (!label) continue;
    const m = METRICS.find((x) => x[3].test(label));
    if (m) { for (const [i, p] of cols) { const v = num(r[i]); if (v != null) platforms[p][m[0]] = v; } continue; }
    const n = NOTES.find((x) => x[2].test(label));
    if (n) { const v = cols.map(([i]) => r[i]).find((x) => x != null && txt(x) !== ""); if (v != null) notes[n[0]] = /views|shares/.test(n[0]) ? num(v) : txt(v).slice(0, 600); }
  }
  // the month: "... OCTOBER 2026 ..." in the first rows
  let month = null;
  for (const r of grid.slice(0, Math.max(head, 3))) { const t = txt(r && r[0]).toLowerCase(); const mm = new RegExp(`(${MONTHS.join("|")})\\s+(20\\d\\d)`).exec(t); if (mm) { month = `${mm[2]}-${String(MONTHS.indexOf(mm[1]) + 1).padStart(2, "0")}`; break; } }
  for (const p of Object.keys(platforms)) if (!Object.keys(platforms[p]).length) delete platforms[p];
  if (!Object.keys(platforms).length) throw new Error("The file has no figures in the platform columns.");
  return { month, platforms, notes };
}

async function saveMonth(month, data, by) {
  await pool.query(`INSERT INTO social_insights (month, data, updated_by) VALUES ($1, $2, $3) ON CONFLICT (month) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [month + "-01", JSON.stringify(data), by]);
  await audit(pool, by, "social.insights", "social_insights", month, null, { platforms: Object.keys(data.platforms || {}) });
}
async function loadMonths(fromM, toM) {
  return (await pool.query("SELECT to_char(month, 'YYYY-MM') AS m, data FROM social_insights WHERE month BETWEEN $1 AND $2 ORDER BY month", [fromM + "-01", toM + "-01"])).rows
    .map((r) => ({ m: r.m, platforms: Object.fromEntries(Object.entries(r.data.platforms || {}).map(([p, v]) => [p, calc(v)])), notes: r.data.notes || {} }));
}

/** The period's figures: totals across platforms and months (followers = at the end), plus the months for the line. */
async function insightsFor(per) {
  const H = E.helpers, endM = per.end.slice(0, 7), startM = per.start.slice(0, 7);
  const all = await loadMonths(H.addMonths(endM, -11), endM);
  const inP = all.filter((x) => x.m >= startM && x.m <= endM);
  if (!inP.length) return null;
  const last = inP[inP.length - 1], first = inP[0];
  const platforms = [...new Set(inP.flatMap((x) => Object.keys(x.platforms)))];
  const sum = (k) => { let t = null; for (const x of inP) for (const p of Object.values(x.platforms)) if (p[k] != null) t = (t || 0) + p[k]; return t; };
  const byP = Object.fromEntries(platforms.map((p) => { const s = (k) => { let t = null; for (const x of inP) if (x.platforms[p] && x.platforms[p][k] != null) t = (t || 0) + x.platforms[p][k]; return t; };
    const lastP = [...inP].reverse().find((x) => x.platforms[p]) || {}, firstP = inP.find((x) => x.platforms[p]) || {};
    const fe = (lastP.platforms || {})[p] ? lastP.platforms[p].followers_end : null, fs = (firstP.platforms || {})[p] ? firstP.platforms[p].followers_start : null;
    const v = { followers: fe, start: fs, views: s("views"), reach: s("reach"), interactions: s("interactions"), published: s("published"), stories: s("stories"), video_views: s("video_views") };
    v.eng = v.interactions != null && v.views ? v.interactions / v.views : null; v.net = fe != null && fs != null ? fe - fs : null; return [p, v]; }));
  platforms.sort((a, b) => (byP[b].followers || 0) - (byP[a].followers || 0)); // biggest audience first
  const followers = platforms.reduce((s, p) => s + (byP[p].followers || 0), 0), start = platforms.reduce((s, p) => s + (byP[p].start || 0), 0);
  const T = { followers, net: followers && start ? followers - start : null, growth: start ? (followers - start) / start : null,
    reach: sum("reach"), nonfollower: sum("nonfollower_reach"), views: sum("views"), video_views: sum("video_views"), interactions: sum("interactions"),
    published: sum("published"), stories: sum("stories"), profile_visits: sum("profile_visits"), link_clicks: sum("link_clicks") };
  T.eng = T.interactions != null && T.views ? T.interactions / T.views : null;
  const noteOf = (k) => { for (const x of [...inP].reverse()) if (x.notes[k] != null && x.notes[k] !== "") return x.notes[k]; return null; };
  return { per, months: inP, trend: all.filter((x) => x.m <= endM).slice(-6), platforms, byP, T, notes: Object.fromEntries(NOTES.map(([k]) => [k, noteOf(k)])), last, first };
}

const pctTxt = (v, d = 1) => (v == null ? "—" : (v * 100).toFixed(d) + "%");
const kfmt = (v) => (v == null ? "—" : v >= 100000 ? (v / 1000).toFixed(0) + "k" : v >= 10000 ? (v / 1000).toFixed(1) + "k" : nf(v));

/** Short lines for the one-page report ("Social media campaigns" and "Marketing highlights"), from marketing's latest upload. */
function summaryLines(I) {
  if (!I) return null;
  const T = I.T, n = I.notes, one = (t, k = 200) => String(t || "").replace(/\s+/g, " ").trim().slice(0, k);
  const social = [n.campaign ? `${one(n.campaign, 80)}${[n.campaign_views != null ? `${kfmt(n.campaign_views)} views` : "", n.campaign_shares != null ? `${nf(n.campaign_shares)} shares` : ""].filter(Boolean).map((x, i) => (i ? " · " : ": ") + x).join("")}` : "",
    n.top_theme ? `Best content: ${one(n.top_theme, 80)}` : ""].filter(Boolean);
  const grow = T.net != null ? ` (${T.net >= 0 ? "+" : "−"}${nf(Math.abs(T.net))}${T.growth != null ? `, ${T.growth >= 0 ? "+" : ""}${(T.growth * 100).toFixed(1)}%` : ""})` : "";
  const marketing = [T.followers ? `${nf(T.followers)} followers${grow} on ${I.platforms.join(" and ")}` : "",
    [T.reach != null ? `${kfmt(T.reach)} accounts reached` : "", T.views != null ? `${kfmt(T.views)} content views` : "", T.eng != null ? `${pctTxt(T.eng)} engagement rate` : ""].filter(Boolean).join(" · "),
    T.published != null ? `${nf(T.published)} posts${T.stories ? ` and ${nf(T.stories)} stories` : ""} published` : "",
    n.learning ? `Learning: ${one(n.learning)}` : ""].filter(Boolean);
  return { social: social.join("\n"), marketing: marketing.join("\n") };
}

/** Every metric for the period, by platform (a month: one column per platform; a quarter or year: also per month). */
function fullTable(I) {
  const cols = I.platforms;
  const rowsFor = (getter) => [...METRICS.map(([k, l]) => [h(l), ...cols.map((p) => getter(p, k))]),
    ["<b>Net new followers</b>", ...cols.map((p) => getter(p, "net"))], ["<b>Total interactions</b>", ...cols.map((p) => getter(p, "interactions"))],
    ["<b>Engagement rate (by views)</b>", ...cols.map((p) => getter(p, "eng_rate", true))], ["<b>Share rate</b>", ...cols.map((p) => getter(p, "share_rate", true))], ["<b>Save rate</b>", ...cols.map((p) => getter(p, "save_rate", true))]];
  const fmt = (v, rate) => (v == null ? "—" : rate ? pctTxt(v, 2) : nf(v));
  const tables = I.months.map((x) => `<h3>${h(monLabel(x.m, true))}</h3>${mini(["Metric", ...cols], rowsFor((p, k, rate) => fmt((x.platforms[p] || {})[k], rate)), { num: cols.map((_, i) => i + 1) })}`).join("");
  const n = I.notes;
  const notes = NOTES.filter(([k]) => n[k] != null && n[k] !== "").map(([k, l]) => `<dt>${h(l)}</dt><dd>${k === "top_url" && /^https:\/\//.test(n[k]) ? `<a href="${h(n[k])}" target="_blank" rel="noopener noreferrer">${h(n[k])}</a>` : h(typeof n[k] === "number" ? nf(n[k]) : n[k])}</dd>`).join("");
  return `${tables}${notes ? `<h3>Campaigns &amp; learnings</h3><dl class="sv-dl">${notes}</dl>` : ""}`;
}

/** The management section: five clickable figures, by platform, followers by month, and three cards. */
function insightsHtml(I) {
  if (!I) return "";
  const T = I.T, full = { title: `Social media insights · ${I.per.label}`, html: fullTable(I) };
  const byPlatform = (k, fmt) => mini(["Platform", "This period"], I.platforms.map((p) => [h(p), fmt(I.byP[p][k])]), { num: [1] });
  const tiles = [
    { label: "Followers", value: nf(T.followers), note: T.net != null ? `${T.net >= 0 ? "▲" : "▼"} ${nf(Math.abs(T.net))} (${T.growth != null ? (T.growth >= 0 ? "+" : "") + (T.growth * 100).toFixed(1) + "%" : "—"})` : "", detail: { title: "Followers by platform", html: mini(["Platform", "At the start", "At the end", "Net new"], I.platforms.map((p) => [h(p), nf(I.byP[p].start), nf(I.byP[p].followers), I.byP[p].net == null ? "—" : (I.byP[p].net >= 0 ? "+" : "") + nf(I.byP[p].net)]), { num: [1, 2, 3] }) } },
    { label: "Accounts reached", value: kfmt(T.reach), note: T.nonfollower != null ? `${kfmt(T.nonfollower)} non-followers` : "", detail: { title: "Reach by platform", html: byPlatform("reach", nf) } },
    { label: "Content views", value: kfmt(T.views), note: T.video_views != null ? `${kfmt(T.video_views)} video` : "", detail: { title: "Views by platform", html: byPlatform("views", nf) } },
    { label: "Engagement rate", value: pctTxt(T.eng), note: T.interactions != null ? `${nf(T.interactions)} interactions` : "", detail: { title: "Engagement by platform", html: mini(["Platform", "Interactions", "Views", "Engagement rate"], I.platforms.map((p) => [h(p), nf(I.byP[p].interactions), nf(I.byP[p].views), pctTxt(I.byP[p].eng)]), { num: [1, 2, 3] }) + '<p class="hint">Engagement rate = likes, comments, shares and saves ÷ content views.</p>' } },
    { label: "Content published", value: nf(T.published), note: T.stories ? `+ ${nf(T.stories)} stories` : "", detail: { title: "Content by platform", html: byPlatform("published", nf) } },
  ];
  const mx = (k) => Math.max(1e-9, ...I.platforms.map((p) => I.byP[p][k] || 0));
  const bar = (p, k, label) => { const v = I.byP[p][k]; return `<span class="si-b"><i style="width:${v ? Math.max(2, (v / mx(k)) * 100) : 0}%;background:${colorOf(p)}"></i><em>${label(v)}</em></span>`; };
  const rows = [["Followers", "followers", kfmt], ["Views", "views", kfmt], ["Engagement", "eng", pctTxt]];
  const plat = `<div class="si-plat" style="grid-template-columns:110px repeat(${I.platforms.length}, minmax(0,1fr))"><span></span>${I.platforms.map((p) => `<span class="si-ph"><i style="background:${colorOf(p)}"></i>${h(p)}</span>`).join("")}
    ${rows.map(([l, k, f]) => `<span class="si-l">${l}</span>${I.platforms.map((p) => bar(p, k, f)).join("")}`).join("")}</div>`;
  const tr = I.trend.filter((x) => Object.values(x.platforms).some((v) => v.followers_end != null));
  const line = tr.length >= 2 ? lineChart({ categories: tr.map((x) => x.m), short: (m) => monLabel(m), height: 170, label: "Followers by month",
    series: I.platforms.filter((p) => tr.some((x) => (x.platforms[p] || {}).followers_end != null)).slice(0, 3).map((p, i) => ({ name: p, color: colorOf(p), dash: i > 0, values: tr.map((x) => (x.platforms[p] || {}).followers_end || 0) })) })
    : `<p class="hint">The line builds up as each month is added (${tr.length ? "1 month so far" : "no months yet"}).</p>`;
  const n = I.notes;
  const card = (l, title, sub) => (title ? `<div class="si-card" role="button" tabindex="0" data-si-open title="See every metric"><span class="si-cl">${l}</span><b>${h(title)}</b>${sub ? `<span class="si-cs">${sub}</span>` : ""}</div>` : "");
  const cards = [card("Best content", n.top_theme || (n.top_url ? "Top post" : ""), n.top_url && /^https:\/\//.test(n.top_url) ? `<a href="${h(n.top_url)}" target="_blank" rel="noopener noreferrer">View the top post ↗</a>` : ""),
    card("Key campaign", n.campaign, [n.campaign_views != null ? `${kfmt(n.campaign_views)} views` : "", n.campaign_shares != null ? `${nf(n.campaign_shares)} shares` : ""].filter(Boolean).join(" · ")),
    card("Learning", n.learning && String(n.learning).replace(/\s+/g, " ").slice(0, 160), "")].join("");
  return `<section class="card c12 si" id="social"><div class="si-top"><h2>Social media</h2><span class="hint">${h(I.platforms.join(" and "))} · ${h(I.per.label)}</span></div>
      <p class="hint" style="margin:2px 0 10px">Audience growth and how our content performed. Click a figure for the details, or <a href="#social-full" class="si-all">see every metric</a>.</p>
      ${detailTiles(tiles, { cls: "tiles ov-tiles mk-tiles si-tiles" })}
      <div class="grid"><div class="c6"><p class="hint" style="margin:0 0 6px">By platform</p>${plat}</div><div class="c6"><p class="hint" style="margin:0 0 6px">Followers by month</p>${line}</div></div>
      ${cards ? `<div class="si-cards">${cards}</div>` : ""}
      <details class="md-ac si-full" id="social-full"><summary><b>Every metric</b><span class="md-n">${h(I.platforms.join(", "))}</span></summary><div class="md-acd">${fullTable(I)}</div></details>
      <script src="/si.js" defer></script></section>`;
}

/** Marketing's part: upload the month's Excel or type the figures in. */
function inputHtml({ post, month, existing }) {
  return `<section class="card c12 noprint" id="social-in"><h2>Social media insights</h2>
    <p class="lead">Upload the month's insights Excel. The report updates straight away; growth, interactions and rates are worked out for you.</p>
    <form class="si-up" method="post" action="${h(post)}/social/upload" enctype="multipart/form-data">
      <label>Insights Excel<input type="file" name="file" accept=".xlsx" required></label>
      <label>Month <span class="hint">(optional: the month in the file's title is used)</span><input type="month" name="month"></label>
      <div class="toolbar" style="margin:0"><button class="btn primary">Upload</button><a class="btn" href="${h(post)}/social/template?month=${h(month)}">Download template</a></div>
      ${existing ? `<p class="hint" style="margin:0">${h(monLabel(month, true))} is uploaded (${h(Object.keys(existing.platforms).join(", "))}). Uploading that month again replaces it.</p>` : ""}</form></section>`;
}

/** The template marketing can fill in. */
async function template(month) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(monLabel(month, true));
  ws.columns = [{ width: 42 }, { width: 16 }, { width: 16 }, { width: 44 }];
  ws.addRow([`WMF | ${monLabel(month, true).toUpperCase()} SOCIAL MEDIA INSIGHTS`]).font = { bold: true, size: 14 };
  ws.addRow(["Enter the month's figures in the platform columns; calculated figures are worked out in the WMF system."]).font = { italic: true, color: { argb: "FF5D6075" } };
  const hr = ws.addRow(["METRIC", "INSTAGRAM", "TIKTOK", "NOTES / SOURCE"]); hr.font = { bold: true, color: { argb: "FFFFFFFF" } }; hr.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4D6AE0" } }; });
  let sec = "";
  for (const [, l, s] of METRICS) { if (s !== sec) { ws.addRow([(sec = s).toUpperCase()]).font = { bold: true }; } ws.addRow([l.replace(" of month", ` of ${monLabel(month).replace(/ ’\d+$/, "")}`)]); }
  ws.addRow(["CAMPAIGNS & LEARNINGS"]).font = { bold: true };
  for (const [, l] of NOTES) ws.addRow([l]);
  return wb.xlsx.writeBuffer();
}

/** Routes, for the team (post = "/report/marketing") and the marketing link (post = "/m/<token>"). */
function routes(app, { base, guard, by, back, wrap, setFlash, limitPost }) {
  const upload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.post(`${base}/social/upload`, ...limitPost, upload.single("file"), wrap(async (req, res) => {
    const g = await guard(req, res); if (!g) return;
    try {
      if (!req.file) throw new Error("Choose the insights Excel file.");
      const r = await parseInsights(req.file.buffer);
      const m = /^\d{4}-\d{2}$/.test(req.body.month || "") ? req.body.month : r.month;
      if (!/^\d{4}-\d{2}$/.test(m || "")) throw new Error("Choose the month.");
      await saveMonth(m, { platforms: r.platforms, notes: r.notes }, by(req, g));
      setFlash(req, "ok", `${monLabel(m, true)}: ${Object.keys(r.platforms).join(" and ")} figures saved.`);
      res.redirect(303, back(req, g, m) + "#social");
    } catch (e) { setFlash(req, "err", e.message); res.redirect(303, back(req, g) + "#social-in"); }
  }));
  app.get(`${base}/social/template`, wrap(async (req, res) => {
    const g = await guard(req, res); if (!g) return;
    const m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : E.helpers.addMonths(R.todayLocal().slice(0, 7), -1);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="WMF_${m}_Social_Media_Insights.xlsx"`).send(Buffer.from(await template(m)));
  }));
}

module.exports = { summaryLines, insightsFor, insightsHtml, inputHtml, parseInsights, saveMonth, loadMonths, routes, calc, METRICS };
