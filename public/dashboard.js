/* WMF Community Dashboard — UI layer. All figures come from WMFEngine (engine.js). */
(function () {
  "use strict";
  const E = window.WMFEngine, H = E.helpers;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (n, d = 0) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const pct = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monLabel = (m, long) => `${(long ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] : MON)[+m.slice(5, 7) - 1]} ${long ? m.slice(0, 4) : "’" + m.slice(2, 4)}`;
  const dayLabel = (d) => d ? `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : "—";

  const PAGES = [["overview", "Overview"], ["performance", "Performance"], ["members", "Members"], ["qr", "QR codes"], ["quality", "Data quality"], ["reports", "Reports"], ["about", "About this data"]];
  const ROLE_TEXT = { admin: "Administrator", coordinator: "Coordinator", viewer: "Viewer", sponsor: "Sponsor" };
  const state = {
    page: "overview", role: "admin", demo: "normal",
    f: { periodType: "month", period: "", from: "", to: "", location: "", kind: "", activity: "", recordType: "", status: "", activeStatus: "", memberType: "", source: "" },
    report: { type: "month", period: "" }, showTable: {},
  };
  let DATA = null, P = null, P_EMPTY = null, ASOF = null, cur = null, prev = null, range = null;

  try { const h = (location.hash || "").slice(1); if (PAGES.some(([k]) => k === h)) state.page = h; } catch (e) { /* no hash */ }
  if (ROLE_TEXT[window.WMF_ROLE]) state.role = window.WMF_ROLE;

  // ---------------- periods ----------------
  function periodOptions(type) {
    const startM = (P.dataStart || ASOF).slice(0, 7), endM = ASOF.slice(0, 7);
    if (type === "month") return H.monthsBetween(startM, endM).reverse().map((m) => [m, monLabel(m, true) + (m === endM ? " (to date)" : "")]);
    if (type === "quarter") {
      const qs = []; for (const m of H.monthsBetween(startM, endM)) { const q = H.quarterOf(m + "-01"); if (!qs.includes(q)) qs.push(q); }
      return qs.reverse().map((q) => [q, q.replace(" ", " · ") + (q === H.quarterOf(ASOF) ? " (to date)" : "")]);
    }
    if (type === "year") { const ys = []; for (let y = +endM.slice(0, 4); y >= +startM.slice(0, 4); y--) ys.push([String(y), String(y) + (y === +endM.slice(0, 4) ? " (to date)" : "")]); return ys; }
    return [];
  }
  function rangeOf(type, period, from, to) {
    if (type === "month") return { start: period + "-01", end: H.monthEnd(period), label: monLabel(period, true) };
    if (type === "quarter") { const y = period.slice(0, 4), q = +period.slice(-1); const s = `${y}-${String(q * 3 - 2).padStart(2, "0")}`; return { start: s + "-01", end: H.monthEnd(H.addMonths(s, 2)), label: `Q${q} ${y}` }; }
    if (type === "year") return { start: period + "-01-01", end: period + "-12-31", label: period };
    if (type === "last12") { const s = H.addMonths(ASOF.slice(0, 7), -11); return { start: s + "-01", end: H.monthEnd(ASOF.slice(0, 7)), label: "the last 12 months" }; }
    if (type === "all") return { start: P.dataStart, end: ASOF, label: "all time" };
    const a = from || H.addDays(ASOF, -29), b = to || ASOF;
    return { start: a <= b ? a : b, end: a <= b ? b : a, label: `${dayLabel(a <= b ? a : b)} – ${dayLabel(a <= b ? b : a)}` };
  }
  function prevLabelOf(r, type) {
    const p = E.previousPeriod(r.start, r.end);
    if (type === "month") return { ...p, label: monLabel(p.start.slice(0, 7), true) };
    if (type === "quarter") return { ...p, label: `Q${Math.floor((+p.start.slice(5, 7) - 1) / 3) + 1} ${p.start.slice(0, 4)}` };
    if (type === "year") return { ...p, label: p.start.slice(0, 4) };
    return { ...p, label: `${dayLabel(p.start)} – ${dayLabel(p.end)}` };
  }

  // ---------------- data & compute ----------------
  function activeP() { return state.demo === "empty" ? P_EMPTY : P; }
  function recompute() {
    const PP = activeP();
    const f = state.f;
    range = rangeOf(f.periodType, f.period, f.from, f.to);
    const filters = { start: range.start, end: range.end, location: f.location, kind: f.kind, activity: f.activity, recordType: f.recordType, status: f.status, activeStatus: f.activeStatus, memberType: f.memberType, source: f.source };
    cur = E.compute(PP, filters, ASOF);
    const pr = prevLabelOf(range, f.periodType);
    range.prev = pr;
    prev = f.periodType === "all" ? null : E.compute(PP, { ...filters, start: pr.start, end: pr.end }, ASOF, { light: true });
  }

  // ---------------- tooltip ----------------
  const tip = $("#tip");
  function showTip(html, x, y) { tip.innerHTML = html; tip.hidden = false; const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 14)) + "px"; tip.style.top = Math.max(8, y - h - 12) + "px"; }
  function hideTip() { tip.hidden = true; }
  document.addEventListener("pointerover", (e) => { const t = e.target.closest("[data-tip]"); if (t) showTip(t.getAttribute("data-tip"), e.clientX, e.clientY); });
  document.addEventListener("pointermove", (e) => { const t = e.target.closest("[data-tip]"); if (t && !tip.hidden) showTip(t.getAttribute("data-tip"), e.clientX, e.clientY); });
  document.addEventListener("pointerout", (e) => { if (e.target.closest("[data-tip]")) hideTip(); });
  document.addEventListener("focusin", (e) => { const t = e.target.closest("[data-tip]"); if (t) { const r = t.getBoundingClientRect(); showTip(t.getAttribute("data-tip"), r.left + r.width / 2, r.top); } });
  document.addEventListener("focusout", hideTip);
  const tipHtml = (value, label, sub) => `<b>${esc(value)}</b><br>${esc(label)}${sub ? `<br><span style="opacity:.75">${esc(sub)}</span>` : ""}`;

  // small-count protection for sponsor view
  const cnt = (v) => (state.role === "sponsor" && v > 0 && v < E.RULES.smallCount ? "<5" : nf(v));

  // ---------------- charts (hand-drawn SVG, scaled to the card) ----------------
  function niceScale(max, ticks = 4) {
    if (!max || max <= 0) return { max: 1, step: 1 };
    const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const st = step < 1 && Number.isInteger(max) ? 1 : step;
    return { max: Math.ceil(max / st) * st, step: st };
  }
  const svgNS = (w, h, body, label) => `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
  const topRounded = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
  const rightRounded = (x, y, w, h, r) => { r = Math.min(r, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; };

  /** Columns over categories. series: [{name,color,values}], stacked or grouped. */
  function columns(el, o) {
    const W = Math.max(300, el.clientWidth || 600), Hh = o.height || 240, m = { l: 44, r: 12, t: 22, b: 30 };
    const pw = W - m.l - m.r, ph = Hh - m.t - m.b, n = o.categories.length;
    if (!n || o.series.every((s) => s.values.every((v) => !v))) { el.innerHTML = emptyHtml(o.emptyText); return; }
    const totals = o.categories.map((_, i) => o.stacked ? o.series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...o.series.map((s) => s.values[i] || 0)));
    const sc = niceScale(Math.max(...totals)), y = (v) => m.t + ph - (v / sc.max) * ph;
    const band = pw / n, groupW = Math.min(o.stacked ? 26 : 40, band * 0.7), barW = o.stacked ? groupW : Math.min(22, (groupW - 2 * (o.series.length - 1)) / o.series.length);
    let g = `<g class="grid">`;
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${nf(v, sc.step < 1 ? 1 : 0)}</text>`;
    g += `</g>`;
    const every = Math.max(1, Math.ceil(n / Math.floor(pw / 46)));
    let marks = "", labels = "";
    o.categories.forEach((c, i) => {
      const cx = m.l + band * i + band / 2, faded = o.faded && o.faded(i);
      let acc = 0;
      o.series.forEach((s, si) => {
        const v = s.values[i] || 0; if (!v) return;
        let x, top, h;
        if (o.stacked) { x = cx - barW / 2; top = y(acc + v); h = y(acc) - top - (acc > 0 ? 2 : 0); acc += v; }
        else { x = cx - groupW / 2 + si * (barW + 2); top = y(v); h = y(0) - top; }
        if (h < 0.5) h = 0.5;
        const isTop = !o.stacked || o.series.slice(si + 1).every((t) => !t.values[i]);
        const d = isTop ? topRounded(x, top, barW, h, 4) : `M${x},${top}h${barW}v${h}h${-barW}Z`;
        const tipT = tipHtml(o.fmt ? o.fmt(v) : cnt(v), `${s.name} · ${o.catLabel ? o.catLabel(c) : c}`, o.stacked && o.series.length > 1 ? `Total ${nf(totals[i])}` : "");
        marks += `<path class="mark" d="${d}" fill="${s.color}" opacity="${faded ? 0.38 : 1}" tabindex="0" data-tip="${esc(tipT)}" aria-label="${esc(s.name)}, ${esc(o.catLabel ? o.catLabel(c) : c)}: ${esc(nf(v))}"/>`;
      });
      if ((i % every === 0 && n - 1 - i >= every) || i === n - 1) labels += `<text x="${cx}" y="${Hh - 10}" text-anchor="middle" class="lab">${esc(o.catShort ? o.catShort(c) : c)}</text>`;
    });
    // one direct label: the latest category's total
    const li = o.labelIndex != null ? o.labelIndex : n - 1;
    if (totals[li]) labels += `<text class="val" x="${m.l + band * li + band / 2}" y="${y(totals[li]) - 6}" text-anchor="middle">${esc(o.fmt ? o.fmt(totals[li]) : cnt(totals[li]))}</text>`;
    const base = `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    el.innerHTML = legendHtml(o.series, "rect") + svgNS(W, Hh, g + marks + base + labels, o.label);
  }

  /** Lines with a crosshair. series: [{name,color,values}] */
  function lines(el, o) {
    const W = Math.max(300, el.clientWidth || 600), Hh = o.height || 230, m = { l: 44, r: 40, t: 18, b: 30 };
    const pw = W - m.l - m.r, ph = Hh - m.t - m.b, n = o.categories.length;
    if (!n || o.series.every((s) => s.values.every((v) => !v))) { el.innerHTML = emptyHtml(o.emptyText); return; }
    const sc = niceScale(Math.max(...o.series.flatMap((s) => s.values))), y = (v) => m.t + ph - (v / sc.max) * ph, x = (i) => m.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
    let g = `<g class="grid">`;
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${nf(v)}</text>`;
    g += `</g>`;
    let body = "";
    if (o.shade) { const idx = o.categories.map((c, i) => (o.shade(i) ? i : -1)).filter((i) => i >= 0); if (idx.length) { const a = x(idx[0]) - (idx[0] ? pw / (n - 1) / 2 : 0), b = x(idx[idx.length - 1]) + (idx[idx.length - 1] < n - 1 ? pw / (n - 1) / 2 : 0); body += `<rect x="${a}" y="${m.t}" width="${Math.max(2, b - a)}" height="${ph}" fill="var(--accent-wash)"/>`; } }
    o.series.forEach((s) => {
      const pts = s.values.map((v, i) => `${x(i)},${y(v || 0)}`).join(" ");
      if (o.series.length === 1) body += `<polygon points="${m.l},${y(0)} ${pts} ${x(n - 1)},${y(0)}" fill="${s.color}" opacity=".1"/>`;
      body += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const lv = s.values[n - 1] || 0;
      body += `<circle cx="${x(n - 1)}" cy="${y(lv)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/><text class="val" x="${x(n - 1) + 8}" y="${y(lv) + 4}">${esc(cnt(lv))}</text>`;
    });
    const every = Math.max(1, Math.ceil(n / Math.floor(pw / 46)));
    let labels = ""; o.categories.forEach((c, i) => { if ((i % every === 0 && n - 1 - i >= every) || i === n - 1) labels += `<text x="${x(i)}" y="${Hh - 10}" text-anchor="middle" class="lab">${esc(o.catShort ? o.catShort(c) : c)}</text>`; });
    const cross = `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>`;
    const hit = `<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" tabindex="0" aria-label="${esc(o.label)}. Use arrow keys to read values."/>`;
    el.innerHTML = legendHtml(o.series, "line") + svgNS(W, Hh, g + body + `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>` + labels + cross + hit, o.label);
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh"), rect = svg.querySelector(".hit");
    let cur = n - 1;
    const show = (i, cx, cy) => {
      cur = Math.max(0, Math.min(n - 1, i)); xh.setAttribute("x1", x(cur)); xh.setAttribute("x2", x(cur)); xh.setAttribute("visibility", "visible");
      const rows = o.series.map((s) => `<span class="k" style="background:${s.color}"></span><b>${esc(cnt(s.values[cur] || 0))}</b> ${esc(s.name)}`).join("<br>");
      showTip(`${esc(o.catLabel ? o.catLabel(o.categories[cur]) : o.categories[cur])}<br>${rows}`, cx, cy);
    };
    const toIdx = (ev) => { const b = svg.getBoundingClientRect(); const px = ((ev.clientX - b.left) / b.width) * W; return Math.round(((px - m.l) / pw) * (n - 1)); };
    rect.addEventListener("pointermove", (ev) => show(toIdx(ev), ev.clientX, ev.clientY));
    rect.addEventListener("pointerleave", () => { xh.setAttribute("visibility", "hidden"); hideTip(); });
    rect.addEventListener("focus", () => { const b = svg.getBoundingClientRect(); show(cur, b.left + (x(cur) / W) * b.width, b.top + 20); });
    rect.addEventListener("blur", () => { xh.setAttribute("visibility", "hidden"); hideTip(); });
    rect.addEventListener("keydown", (ev) => { if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); const b = svg.getBoundingClientRect(); const i = cur + (ev.key === "ArrowRight" ? 1 : -1); show(i, b.left + (x(Math.max(0, Math.min(n - 1, i))) / W) * b.width, b.top + 20); } });
  }

  /** Horizontal bars, one series. items: [{name,value,sub}] */
  function hbars(el, o) {
    const items = o.items.slice(0, o.limit || 12);
    if (!items.length || items.every((d) => !d.value)) { el.innerHTML = emptyHtml(o.emptyText, o.noReset); return; }
    const W = Math.max(300, el.clientWidth || 500), row = 30, labW = Math.min(230, W * 0.4), m = { t: 4, r: 56 };
    const Hh = m.t + items.length * row + 4, max = o.max || Math.max(...items.map((d) => d.value)), pw = W - labW - m.r;
    let body = "";
    items.forEach((d, i) => {
      const yy = m.t + i * row, w = Math.max(d.value ? 2 : 0, (d.value / max) * pw);
      const maxCh = Math.floor((labW - 14) / 6.6), name = d.name.length > maxCh ? d.name.slice(0, maxCh - 1) + "…" : d.name;
      const shown = o.fmt ? o.fmt(d.value) : cnt(d.value);
      body += `<text class="lab" x="${labW - 10}" y="${yy + row / 2 + 4}" text-anchor="end">${esc(name)}</text>`;
      body += `<path class="mark" d="${rightRounded(labW, yy + (row - 16) / 2, w, 16, 4)}" fill="${d.color || o.color}" tabindex="0" data-tip="${esc(tipHtml(shown, d.name, d.sub))}" aria-label="${esc(d.name)}: ${esc(shown)}"/>`;
      body += `<text class="val" x="${labW + w + 6}" y="${yy + row / 2 + 4}">${esc(shown)}</text>`;
    });
    body += `<line class="base" x1="${labW}" x2="${labW}" y1="${m.t}" y2="${Hh - 4}"/>`;
    el.innerHTML = svgNS(W, Hh, body, o.label);
  }

  const legendHtml = (series, kind) => series.length < 2 ? "" : `<ul class="legend">${series.map((s) => `<li><i class="${kind === "line" ? "line" : ""}" style="background:${s.color}"></i>${esc(s.name)}</li>`).join("")}</ul>`;
  const emptyHtml = (text, noReset) => `<div class="empty"><span>${esc(text || "No records match these filters.")}</span>${noReset || !activeFilterText() ? "" : `<button class="btn" data-act="reset">Clear filters</button>`}</div>`;

  // table view for every chart
  // numeric columns (all values look like numbers, percentages or "—") are right-aligned
  function tableHtml(headers, rows) {
    const isNum = headers.map((_, i) => i > 0 && rows.length > 0 && rows.every((r) => /^[<>+\-−]?[\d,.]*%?$|^—$|^New$|^Not comparable$|^As of today$/.test(String(r[i] == null ? "" : r[i]).trim())));
    return `<div class="tw"><table><thead><tr>${headers.map((h, i) => `<th class="${isNum[i] ? "n" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${isNum[i] ? "n" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function chartCard(id, title, lead, span, tbl) {
    const open = !!state.showTable[id];
    return `<section class="card ${span}" aria-labelledby="h-${id}"><div class="card-head"><div><h2 id="h-${id}">${esc(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}</div>
      ${tbl ? `<button class="btn ghost tblbtn" data-act="table" data-id="${id}" aria-expanded="${open}">${open ? "Hide table" : "Show table"}</button>` : ""}</div>
      <div class="chart" id="ch-${id}"></div>${tbl && open ? `<div class="noprint">${tbl}</div>` : ""}</section>`;
  }

  // ---------------- tiles ----------------
  function delta(key, upGood = true, fmtFn) {
    if (!prev) return "";
    const a = cur.kpis[key], b = prev.kpis[key];
    if (a == null || b == null) return "";
    if ((key === "rideAttendance" || key === "rideSessions") && E.isMixChanged(cur.kpis, prev.kpis)) return `<span class="delta">Not comparable with ${esc(range.prev.label)}</span>`;
    if (a === b) return `<span class="delta">Same as ${esc(range.prev.label)}</span>`;
    const d = a - b, cls = (d > 0) === upGood ? "up" : "down";
    const p = b ? ` (${d > 0 ? "+" : ""}${Math.round((d / b) * 100)}%)` : "";
    return `<span class="delta"><span class="${cls}">${d > 0 ? "▲" : "▼"} ${esc(fmtFn ? fmtFn(Math.abs(d)) : nf(Math.abs(d)))}${p}</span> vs ${esc(range.prev.label)}</span>`;
  }
  const tile = (label, value, extra = "", attn = false, na = false) => `<div class="tile${attn ? " attn" : ""}"><span class="lbl">${esc(label)}</span><span class="val${na ? " na" : ""}">${na ? esc(value) : value}</span>${extra}</div>`;

  // ---------------- alerts ----------------
  function alertsHtml() {
    const a = [], k = cur.kpis;
    const comparable = !prev || !E.isMixChanged(k, prev.kpis);
    if (state.demo === "cached") a.push(["info", "i", `<b>Showing the last good snapshot</b> from 30 Sep 2026, 13:00. The 14:00 refresh failed, so these figures may be up to an hour old.`]);
    if (!comparable) a.push(["warn", "!", `<b>Ride attendance is not like-for-like with ${esc(range.prev.label)}.</b> Historical headcounts (all riders) end on ${dayLabel(activeP().historyEnd)}; later rides count registered riders only.`]);
    if (state.role !== "sponsor" && k.followUp) a.push(["warn", "!", `<b>${nf(k.followUp)} members need a follow-up:</b> lapsed after being active, or no second visit yet.`]);
    if (state.role !== "sponsor" && k.qrReady) a.push(["info", "i", `<b>${nf(k.qrReady)} QR codes are Ready to Send.</b> Sending is switched off in this read-only version.`]);
    if (state.role !== "sponsor" && k.recordsWithErrors) a.push(["crit", "!", `<b>${nf(k.recordsWithErrors)} records have a data-quality issue.</b> ${nf(k.excludedRows)} rows in this period are left out of the figures (repeat copies or double counts).`]);
    if (!a.length) return "";
    return `<div class="alerts" role="region" aria-label="Alerts">${a.map(([c, i, t]) => `<div class="alert ${c}"><span class="ic" aria-hidden="true">${i}</span><span>${t}</span></div>`).join("")}</div>`;
  }

  // ---------------- pages ----------------
  const sponsorLock = (what) => `<div class="lock"><b>Not available to sponsors</b><span>${esc(what)} Sponsors see aggregate figures only, with small counts shown as “&lt;5”.</span></div>`;
  const perLabel = () => `${range.label}${prev ? ` · compared with ${range.prev.label}` : ""}`;

  function pageOverview() {
    const k = cur.kpis, total = k.activeMembers + k.inactiveMembers;
    const hero = `<section class="card"><h2>Active members now</h2>
      <p class="hero-num">${esc(cnt(k.activeMembers))}</p>
      <p class="hero-cap">Riders with 2 or more rides in the 90 days to ${dayLabel(ASOF)}, plus first-time riders within 90 days of their first ride.</p>
      <div class="meter" aria-hidden="true"><div class="meter-bar"><span style="flex:${k.activeMembers || 0};background:var(--s1)"></span><span style="flex:${k.inactiveMembers || 0};background:var(--axis)"></span></div>
        <div class="meter-key"><span><i style="background:var(--s1)"></i>Active ${esc(cnt(k.activeMembers))} (${total ? Math.round((k.activeMembers / total) * 100) : 0}%)</span><span><i style="background:var(--axis)"></i>Inactive ${esc(cnt(k.inactiveMembers))}</span></div></div>
      <ul class="hero-list"><li><span>Took part in ${esc(range.label)}</span><b>${esc(cnt(k.participants))}</b></li><li><span>First-timers in ${esc(range.label)}</span><b>${esc(cnt(k.firstTimers))}</b></li></ul></section>`;
    const tiles1 = [
      tile("Total unique members", cnt(k.uniqueMembers), `<span class="note">As at ${dayLabel(range.end > ASOF ? ASOF : range.end)}</span>`),
      tile("New members", cnt(k.newMembers), delta("newMembers")),
      tile("Inactive members", cnt(k.inactiveMembers), `<span class="note">Not active under the ride rule</span>`),
      tile("Members taking part", cnt(k.participants), delta("participants")),
      tile("Returning for another visit", cnt(k.returning), `<span class="note">Took part before this period</span>`),
      tile("Retention, 30 days", k.retention[30].rate == null ? "Not measurable yet" : pct(k.retention[30].rate), k.retention[30].rate == null ? `<span class="note">First visits in this period are under 30 days old</span>` : `<span class="note">${nf(k.retention[30].retained)} of ${nf(k.retention[30].eligible)} first-timers came back</span>`, false, k.retention[30].rate == null),
      tile("Average participation per member", k.avgPerMember == null ? "—" : nf(k.avgPerMember, 1), ""),
      state.role === "sponsor" ? "" : tile("Members needing follow-up", nf(k.followUp), `<span class="note">As of today</span>`, k.followUp > 0),
    ].join("");
    const tiles2 = [
      tile("Qualifying participations", cnt(k.qualifying), delta("qualifying")),
      tile("Ride sessions", nf(k.rideSessions), delta("rideSessions")),
      tile("Ride attendance", cnt(k.rideAttendance), delta("rideAttendance")),
      tile("Events", nf(k.events), ""),
      tile("Event registrations", cnt(k.eventRegistrations), delta("eventRegistrations")),
      k.largeEvents.attendance ? tile("Large public events", cnt(k.largeEvents.attendance), `<span class="note">Shown separately: ${esc(k.largeEvents.names.join(", "))}</span>`) : "",
      tile("Attendance rate", "Not reported", `<span class="note">Rides take no registrations; each event registration already counts as attendance</span>`, false, true),
      state.role === "sponsor" ? "" : tile("QR codes Ready to Send", nf(k.qrReady), "", k.qrReady > 0),
      state.role === "sponsor" ? "" : tile("QR codes Sent", nf(k.qrSent), ""),
      state.role === "sponsor" ? "" : tile("Records with data issues", nf(k.recordsWithErrors), `<span class="note">Across the whole workbook</span>`, k.recordsWithErrors > 0),
    ].join("");
    return `${alertsHtml()}
      <div class="hero">${hero}<section class="card"><div class="card-head"><div><h2>${esc(cap(range.label))}</h2><p class="lead">${esc(perLabel())}</p></div><div><button class="btn tblbtn" data-act="copyCSV">Copy filtered data (CSV)</button> <span class="toast" id="oToast" role="status"></span></div></div><div class="tiles">${tiles1}</div></section></div>
      <p class="section-title">Rides, events and QR codes</p><div class="tiles">${tiles2}</div>
      <div class="grid">
        ${chartCard("rideMonth", "Ride attendance by month", "Historical headcounts count every rider; after they end, only registered riders (forms, QR scans, manual entries) are counted. The selected period is in full colour.", "c8", trendTable(["Month", "Historical headcounts", "Registered riders", "Total"], (t) => [monLabel(t.month), t.rideHistory, t.rideAttendance - t.rideHistory, t.rideAttendance]))}
        ${chartCard("newMembers", "New members by month", "Members whose first record falls in the month.", "c4", trendTable(["Month", "New members"], (t) => [monLabel(t.month), t.newMembers]))}
        ${chartCard("qualMonth", "Qualifying participations by month", "Named riders plus event registrations, each person counted once per activity per day.", "c12", trendTable(["Month", "Qualifying participations"], (t) => [monLabel(t.month), t.qualifying]))}
      </div>`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const trendTable = (h, f) => tableHtml(h, cur.trend.map((t) => f(t).map((v, i) => (i ? cnt(v) : v))));

  function mountOverview() {
    const T = cur.trend, faded = (i) => !T[i].inPeriod;
    columns($("#ch-rideMonth"), { categories: T.map((t) => t.month), stacked: true, faded, label: "Ride attendance by month", catShort: (m) => monLabel(m), catLabel: (m) => monLabel(m, true),
      series: [{ name: "Historical headcounts", color: "var(--s1)", values: T.map((t) => t.rideHistory) }, { name: "Registered riders", color: "var(--s2)", values: T.map((t) => t.rideAttendance - t.rideHistory) }] });
    columns($("#ch-newMembers"), { categories: T.map((t) => t.month), faded, label: "New members by month", catShort: (m) => monLabel(m), catLabel: (m) => monLabel(m, true), series: [{ name: "New members", color: "var(--s1)", values: T.map((t) => t.newMembers) }] });
    lines($("#ch-qualMonth"), { categories: T.map((t) => t.month), shade: faded ? (i) => T[i].inPeriod : null, label: "Qualifying participations by month", catShort: (m) => monLabel(m), catLabel: (m) => monLabel(m, true), series: [{ name: "Qualifying participations", color: "var(--s1)", values: T.map((t) => t.qualifying) }] });
  }

  function pagePerformance() {
    const k = cur.kpis;
    const rides = cur.activities.filter((a) => a.kind === "Ride" && a.sessions >= 3);
    const top = rides.slice(0, 5), low = rides.slice(-5).reverse();
    const actRow = (a) => [a.name, nf(a.sessions), cnt(a.attendance), nf(a.perSession, 1)];
    const conv = k.regConversion;
    return `${alertsHtml()}
      <div class="tiles">
        ${tile("Registration → first participation", conv.rate == null ? "Not measurable yet" : pct(conv.rate), conv.rate == null ? `<span class="note">Needs new members who joined 30+ days ago</span>` : `<span class="note">${nf(conv.converted)} of ${nf(conv.cohort)} new members took part</span>`, false, conv.rate == null)}
        ${tile("First ride → second ride", k.firstToActive.rate == null ? "Not measurable yet" : pct(k.firstToActive.rate), k.firstToActive.rate == null ? `<span class="note">First rides need to be 90+ days old</span>` : `<span class="note">Second ride within 90 days: ${nf(k.firstToActive.retained)} of ${nf(k.firstToActive.eligible)} first-time riders</span>`, false, k.firstToActive.rate == null)}
        ${tile("New vs returning", `${cnt(k.firstTimers)} / ${cnt(k.returning)}`, `<span class="note">First-timers / returning members</span>`)}
        ${tile("No-show rate", "Not reported", `<span class="note">Event registrations count as attendance</span>`, false, true)}
      </div>
      <div class="grid">
        ${exportBox()}
        ${chartCard("quarter", "Ride attendance by quarter", "Historical headcounts plus registered riders, combined without double counting.", "c6", tableHtml(["Quarter", "Ride attendance", "Qualifying participations"], cur.quarterly.map((q) => [q.quarter, cnt(q.rideAttendance), cnt(q.qualifying)])))}
        ${chartCard("newret", "New and returning members taking part", "Each person counted once per month: in their first month they are new.", "c6", trendTable(["Month", "New", "Returning"], (t) => [monLabel(t.month), t.firstTimers, t.returning]))}
        ${chartCard("series", "Ride attendance by ride", "Weekday ride series, agreed 1 Oct. Older ride names sit inside each series.", "c6", tableHtml(["Ride", "Attendance"], cur.bySeries.map((d) => [d.name, cnt(d.value)])))}
        ${chartCard("location", "Abu Dhabi and Dubai", "Ride attendance by location. Rides count as Abu Dhabi unless they are marked Dubai.", "c6", tableHtml(["Location", "Attendance"], cur.byLocation.map((d) => [d.name, cnt(d.value)])))}
        ${chartCard("events", "Event participation", "Each registration counts as attendance; historical event figures included.", "c6", tableHtml(["Event", "Participation"], cur.byEvent.map((d) => [d.name, cnt(d.value)])))}
        ${chartCard("type", "Rides and events", "Participation by activity type in the period.", "c6", tableHtml(["Type", "Participation"], cur.byType.map((d) => [d.name, cnt(d.value)])))}
        ${chartCard("source", "Where the records come from", "Qualifying rows by data source.", "c12", tableHtml(["Source", "Records"], cur.bySource.map((d) => [d.name, cnt(d.value)])))}
        ${rides.length > 5 ? `<section class="card c6"><h2>Strongest rides</h2><p class="lead">Highest average attendance per session (rides with 3 or more sessions in the period).</p>${tableHtml(["Ride", "Sessions", "Attendance", "Per session"], top.map(actRow))}</section>
        <section class="card c6"><h2>Lowest-attended rides</h2><p class="lead">Lowest average attendance per session, same rule.</p>${tableHtml(["Ride", "Sessions", "Attendance", "Per session"], low.map(actRow))}</section>` :
        `<section class="card c12"><h2>Rides ranked by attendance per session</h2><p class="lead">Strongest first; the last row is the lowest-attended. Rides with 3 or more sessions in the period.</p>${rides.length ? tableHtml(["Ride", "Sessions", "Attendance", "Per session"], rides.map(actRow)) : emptyHtml("Not enough sessions in this period to rank rides.")}</section>`}
      </div>`;
  }
  function mountPerformance() {
    const Q = cur.quarterly;
    columns($("#ch-quarter"), { categories: Q.map((q) => q.quarter), label: "Ride attendance by quarter", catShort: (q) => q.replace(/^\d\d(\d\d) /, "’$1 "), series: [{ name: "Ride attendance", color: "var(--s1)", values: Q.map((q) => q.rideAttendance) }] });
    const T = cur.trend;
    columns($("#ch-newret"), { categories: T.map((t) => t.month), label: "New and returning members by month", catShort: (m) => monLabel(m), catLabel: (m) => monLabel(m, true), faded: (i) => !T[i].inPeriod,
      series: [{ name: "New", color: "var(--s1)", values: T.map((t) => t.firstTimers) }, { name: "Returning", color: "var(--s2)", values: T.map((t) => t.returning) }] });
    hbars($("#ch-series"), { items: cur.bySeries, color: "var(--s1)", label: "Ride attendance by ride" });
    hbars($("#ch-location"), { items: cur.byLocation, color: "var(--s1)", label: "Ride attendance by location", emptyText: "No ride attendance for this location in the period." });
    hbars($("#ch-events"), { items: cur.byEvent, color: "var(--s1)", label: "Event participation", emptyText: "No events in this period." });
    hbars($("#ch-type"), { items: cur.byType, color: "var(--s1)", label: "Participation by activity type" });
    hbars($("#ch-source"), { items: cur.bySource, color: "var(--s1)", label: "Records by source" });
  }

  function personName(p) {
    if (state.role === "admin" || state.role === "coordinator") return p.label;
    return p.memberId || "Not in member list";
  }
  function pageMembers() {
    const k = cur.kpis, r = k.retention;
    const retTbl = tableHtml(["Within", "Came back", "First-timers measured", "Rate"], [30, 60, 90].map((n) => [`${n} days`, nf(r[n].retained), nf(r[n].eligible), pct(r[n].rate)]));
    const engaged = state.role === "sponsor" ? sponsorLock("Named member lists are hidden.") :
      cur.engaged.length ? tableHtml(["Member", "In period", "All time", "Last visit", "Status"], cur.engaged.map((p) => [personName(p), nf(p.inPeriod), nf(p.total), dayLabel(p.last), p.active ? "Active" : "Inactive"])) : emptyHtml();
    let follow;
    if (state.role === "sponsor") follow = sponsorLock("The follow-up list names members.");
    else if (state.role === "viewer") follow = `<p class="lead">${nf(cur.followUp.length)} members are on the follow-up list. Names are visible to coordinators and administrators.</p>`;
    else follow = cur.followUp.length ? tableHtml(["Member", "Why", "Last visit", "Visits"], cur.followUp.slice(0, 12).map((p) => [personName(p), p.reason, dayLabel(p.last), nf(p.total)])) + (cur.followUp.length > 12 ? `<p class="muted">Showing 12 of ${nf(cur.followUp.length)}, oldest last visit first.</p>` : "") : emptyHtml("Nobody needs a follow-up right now.");
    return `<div class="tiles">
        ${tile("Total unique members", cnt(k.uniqueMembers))}
        ${tile("Active now", cnt(k.activeMembers), `<span class="note">2+ rides in 90 days, or a first ride in the last 90 days</span>`)}
        ${tile("Inactive", cnt(k.inactiveMembers))}
        ${tile("New members", cnt(k.newMembers), delta("newMembers"))}
        ${tile("Members taking part", cnt(k.participants), delta("participants"))}
        ${tile("Average participation", k.avgPerMember == null ? "—" : nf(k.avgPerMember, 1), `<span class="note">Per member taking part</span>`)}
      </div>
      <div class="grid">
        ${chartCard("retention", "Member retention after a first visit", "Share of first-timers in the period who came back within 30, 60 and 90 days. Only first visits old enough to measure are counted.", "c6", retTbl)}
        ${chartCard("activeSplit", "Active and inactive members", `Active: 2 or more rides in the 90 days to ${dayLabel(ASOF)}, or a first-time rider within 90 days of the first ride. Event registrations do not count towards active.`, "c6", tableHtml(["Status", "Members"], [["Active", cnt(k.activeMembers)], ["Inactive", cnt(k.inactiveMembers)]]))}
        <section class="card c6"><h2>Most engaged members</h2><p class="lead">Most qualifying participations in ${esc(range.label)}.</p>${engaged}</section>
        <section class="card c6"><h2>Members needing follow-up</h2><p class="lead">Last ride ${E.RULES.lapseDays}–${E.RULES.lapseLookbackDays} days ago, or one ride ${E.RULES.newNoReturnDays}+ days ago with no second ride. As of today.</p>${follow}</section>
      </div>`;
  }
  function mountMembers() {
    const r = cur.kpis.retention;
    hbars($("#ch-retention"), { items: [30, 60, 90].map((n) => ({ name: `Within ${n} days`, value: r[n].rate == null ? 0 : r[n].rate * 100, sub: `${nf(r[n].retained)} of ${nf(r[n].eligible)} first-timers` })), max: 100, fmt: (v) => Math.round(v) + "%", color: "var(--s1)", label: "Retention", noReset: true, emptyText: "Not measurable yet: first visits in this period are too recent. Choose an earlier or longer period to see retention." });
    hbars($("#ch-activeSplit"), { items: [{ name: "Active", value: cur.kpis.activeMembers, color: "var(--s1)" }, { name: "Inactive", value: cur.kpis.inactiveMembers, color: "var(--axis)" }], label: "Active and inactive members" });
  }

  function pageQR() {
    if (state.role === "sponsor") return sponsorLock("QR codes are an operational list.");
    const q = cur.qr, checks = activeP().quality.checks.filter((c) => c.id.startsWith("qr"));
    const ready = activeP().members.filter((m) => m.qrStatus === "Ready to Send");
    const showNames = state.role === "admin" || state.role === "coordinator";
    const readyTbl = !showNames ? `<p class="lead">${nf(ready.length)} members are Ready to Send. Names are visible to coordinators and administrators.</p>` :
      ready.length ? tableHtml(["Member", "Member ID", "Email", "Status since"], ready.map((m) => [m.label, m.memberId, m.email ? m.email.replace(/^(.).*(@.*)$/, "$1•••$2") : "Missing", dayLabel((m.qrCreated || "").slice(0, 10))])) : emptyHtml("Nobody is Ready to Send.");
    return `<div class="alert info"><span class="ic" aria-hidden="true">i</span><span><b>Read-only.</b> This page shows QR status from the workbook. Generating and sending QR codes stays switched off until Phase 2 is approved and tested.</span></div>
      <div class="tiles">${tile("Ready to Send", nf(q.ready), "", q.ready > 0)}${tile("Sent", nf(q.sent))}${tile("Missing email", nf(q.missingEmail), "", q.missingEmail > 0)}${tile("Not eligible yet", nf(q.notEligible), `<span class="note">No registration or ride yet that qualifies</span>`)}</div>
      <div class="grid">
        ${chartCard("qr", "QR status of all members", "Status as recorded in the member list (case-insensitive).", "c6", tableHtml(["Status", "Members"], [["Not eligible", nf(q.notEligible)], ["Missing email", nf(q.missingEmail)], ["Ready to Send", nf(q.ready)], ["Sent", nf(q.sent)]]))}
        <section class="card c6"><h2>QR data checks</h2><p class="lead">From the Data quality page.</p>${tableHtml(["Check", "Records"], checks.map((c) => [c.label, nf(c.count)]))}</section>
        <section class="card c12"><h2>Ready to Send</h2><p class="lead">Rule 10: a QR email needs a Member ID, a valid email and the exact status Ready to Send. Emails are partly hidden here.</p>${readyTbl}</section>
      </div>`;
  }
  function mountQR() {
    if (state.role === "sponsor") return;
    const q = cur.qr;
    hbars($("#ch-qr"), { items: [{ name: "Not eligible", value: q.notEligible, color: "var(--axis)" }, { name: "Missing email", value: q.missingEmail, color: "var(--s2)" }, { name: "Ready to Send", value: q.ready, color: "var(--s3)" }, { name: "Sent", value: q.sent, color: "var(--s1)" }], label: "QR status" });
  }

  function pageQuality() {
    if (state.role === "sponsor") return sponsorLock("Data-quality lists contain member records.");
    const Q = activeP().quality, showRows = state.role === "admin" || state.role === "coordinator";
    const high = Q.checks.filter((c) => c.severity === "high").reduce((a, c) => a + c.count, 0);
    const list = Q.checks.map((c) => {
      const info = c.severity === "info";
      const sev = info ? "info" : c.count === 0 ? "ok" : c.severity;
      const sevTxt = info ? "Info" : c.count === 0 ? "Clear" : { high: "High", medium: "Medium", low: "Low" }[c.severity];
      const rows = c.items.slice(0, 50).map((x) => [x.ref, x.label || "—", x.date ? dayLabel(x.date) : "—", x.field, x.current || "(blank)", x.proposed]);
      const body = !c.count ? `<p class="muted">No records found.</p>` : !showRows ? `<p class="muted">Row details are visible to coordinators and administrators.</p>` :
        tableHtml(["Record", "Member", "Date", "Field", "Current value", "Proposed correction"], rows) + (c.count > 50 ? `<p class="muted">Showing 50 of ${nf(c.count)}. Copy the full list below.</p>` : "");
      return `<details class="dq"><summary><span class="sev ${sev}">${sevTxt}</span><span><span class="t">${esc(c.label)}</span><br><span class="w">${esc(c.why)}</span></span><span class="n" style="text-align:right;font-weight:600">${info ? "" : nf(c.count)}</span></summary><div class="body">${info ? `<p class="muted">${esc(c.why)}</p>` : body}</div></details>`;
    }).join("");
    return `<div class="alert info"><span class="ic" aria-hidden="true">i</span><span><b>Nothing is corrected automatically.</b> Each item is a proposal for an administrator to review in the workbook. Repeat copies and double counts are already left out of every figure.</span></div>
      <div class="tiles">${tile("Records with an issue", nf(Q.flaggedRecords), "", Q.flaggedRecords > 0)}${tile("High-severity items", nf(high), "", high > 0)}${tile("Rows left out of figures", nf(Q.excluded.length), `<span class="note">Repeat copies and double counts</span>`)}${tile("Checks run", nf(Q.checks.length))}</div>
      <section class="card"><div class="card-head"><div><h2>Checks</h2><p class="lead">Open a check to see the records and the proposed correction.</p></div>
        ${state.role === "admin" ? `<div><button class="btn" data-act="copyDQ">Copy correction list (CSV)</button> <span class="toast" id="dqToast" role="status"></span></div>` : ""}</div>${list}</section>
      <section class="card"><h2>Records left out of the figures</h2><p class="lead">With the reason for each.</p>${showRows && Q.excluded.length ? tableHtml(["Record", "Member", "Date", "Reason"], Q.excluded.slice(0, 40).map((x) => [x.ref, x.label, dayLabel(x.date), x.current])) : `<p class="muted">${nf(Q.excluded.length)} rows.${showRows ? "" : " Details are visible to coordinators and administrators."}</p>`}</section>`;
  }

  function reportRange() {
    const t = state.report.type, opts = periodOptions(t);
    if (!state.report.period || !opts.some(([v]) => v === state.report.period)) state.report.period = (opts[t === "month" ? 1 : 0] || opts[0] || [""])[0];
    return rangeOf(t, state.report.period);
  }
  function buildReport() {
    const t = state.report.type, r = reportRange(), pr = prevLabelOf(r, t), PP = activeP();
    const base = {};   // management reports always cover all locations and activities
    const c = E.compute(PP, { ...base, start: r.start, end: r.end }, ASOF), p = E.compute(PP, { ...base, start: pr.start, end: pr.end }, ASOF, { light: true });
    const words = E.commentary(c, p, { cur: r.label, prev: pr.label });
    return { r, pr, c, p, words };
  }
  function pageReports() {
    const R = buildReport(), { r, pr, c, p, words } = R, k = c.kpis, kp = p.kpis;
    const opts = periodOptions(state.report.type).map(([v, l]) => `<option value="${esc(v)}" ${v === state.report.period ? "selected" : ""}>${esc(l)}</option>`).join("");
    const notComparable = E.isMixChanged(k, kp);
    const row = (label, key, f = cnt) => { const a = k[key], b = kp[key]; const nc = notComparable && (key === "rideAttendance" || key === "rideSessions"); const ch = nc ? "Not comparable" : b ? `${a - b >= 0 ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : a ? "New" : "—"; return [label, f(a), f(b), ch]; };
    const rows = [row("Members taking part", "participants"), row("New members", "newMembers"), row("Qualifying participations", "qualifying"), row("Ride sessions", "rideSessions"), row("Ride attendance", "rideAttendance"),
      row("Events", "events"), row("Event participation", "eventParticipation"), ["Large public events (separate)", cnt(k.largeEvents.attendance), cnt(kp.largeEvents.attendance), "—"], row("Returning members", "returning"), ["Active members now", cnt(k.activeMembers), "—", "As of today"], ["Total unique members", cnt(k.uniqueMembers), cnt(kp.uniqueMembers), "—"]];
    const filt = "";
    const li = (a, label) => a.length ? `<ul>${a.map((x) => `<li>${label ? `<span class="lbl">${label}</span>` : ""}${esc(x)}</li>`).join("")}</ul>` : `<p>None this period.</p>`;
    const kind = { month: "Monthly management report", quarter: "Quarterly management report", year: "Annual performance summary" }[state.report.type];
    const risks = state.role === "sponsor" ? words.risks.filter((x) => !/follow-up|data-quality/.test(x)) : words.risks;
    const actions = state.role === "sponsor" ? [] : words.actions;
    return `<div class="toolbar">
        <div class="seg" role="group" aria-label="Report type">${[["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Annual"]].map(([v, l]) => `<button data-act="rtype" data-v="${v}" aria-pressed="${state.report.type === v}">${l}</button>`).join("")}</div>
        <label class="f"><span>Period</span><select id="rPeriod">${opts}</select></label>
        <button class="btn" data-act="copyReport">Copy report text</button>
        <button class="btn" data-act="copyCSV">Copy report data (CSV)</button>
        <a class="btn primary" href="/api/wmf/monthly.xlsx?from=${esc(H.addMonths(reportRange().end.slice(0, 7), -11))}&to=${esc((reportRange().end < ASOF ? reportRange().end : ASOF).slice(0, 7))}">Export 12 months (Excel)</a>
        <span class="toast" id="rToast" role="status"></span>
      </div>
      <p class="fnote noprint">Reports cover all locations and activities. PDF export and file downloads work in the SharePoint version; this preview can't download files, so the buttons copy to your clipboard instead. To copy data for your own filters, use the button on the Overview page.</p>
      <div class="report-wrap"><article class="a4" id="report">
        <h2>${esc(kind)}</h2>
        <p class="meta">Women Moving Forward · ${esc(r.label)} compared with ${esc(pr.label)} · Data as of ${dayLabel(ASOF)}${state.demo === "normal" && P.meta.mode === "sample" ? " · <b>SAMPLE DATA</b>" : ""}${filt ? " · Filters: " + esc(filt) : ""}</p>
        <h3>Key figures</h3>${tableHtml(["Measure", r.label, pr.label, "Change"], rows)}
        <h3>Summary</h3>${li(words.summary)}
        <h3>Key achievements</h3>${li(words.achievements)}
        <h3>Risks and issues</h3>${li(risks)}
        <h3>Recommended actions</h3>${actions.length ? li(actions, "Suggested action") : "<p>None.</p>"}
        <h3>Ride attendance, last 12 months</h3><div class="chart" id="ch-report"></div>
        <p class="foot">Figures are calculated from the workbook's raw records using the rules agreed on 30 Sep and 1 Oct 2026. Statements above are generated from these numbers only; they do not explain causes. Items marked “Suggested action” are recommendations for review. Active members: 2+ rides in the 90 days to the data date, or a first ride within that window. Large public events are shown separately. Ride attendance uses historical headcounts on the dates they cover and registered riders otherwise.</p>
      </article></div>`;
  }
  function mountReports() {
    const R = buildReport(); const T = R.c.trend.slice(-12);
    columns($("#ch-report"), { categories: T.map((t) => t.month), stacked: true, height: 200, faded: (i) => !T[i].inPeriod, label: "Ride attendance, last 12 months", catShort: (m) => monLabel(m), catLabel: (m) => monLabel(m, true),
      series: [{ name: "Historical headcounts", color: "#2a78d6", values: T.map((t) => t.rideHistory) }, { name: "Registered riders", color: "#eb6834", values: T.map((t) => t.rideAttendance - t.rideHistory) }] });
  }

  function pageAbout() {
    const PP = activeP(), m = PP.meta || {};
    const defs = [
      ["Qualifying participation", "A ride with status Attended, or any event registration. Each person counts once per activity per day."],
      ["Active member", "A first-time rider is active for 90 days from the first ride. Everyone else needs 2 or more rides in the 90 days ending today. Only rides count; event registrations do not (agreed 1 Oct)."],
      ["Large public events", "Events named in the settings (e.g. the 1,000-person pro-rider meet & greet) are reported on their own line and left out of event participation."],
      ["Test entries", "Rows from the addresses listed in the settings are removed from every figure."],
      ["Ride session", "A distinct ride on a date: historical sessions plus live rides on dates the history does not cover."],
      ["Ride attendance", "Historical headcounts on the dates they cover (Jan 2024 – " + dayLabel(PP.historyEnd) + " in this sample); registered riders on all other dates. Never both."],
      ["Event participation", "Event registrations (each counts as attendance) plus historical event attendance."],
      ["New member", "First record (registration or first ride) inside the period."],
      ["Returning member", "Took part in the period and had taken part before it started."],
      ["Retention (30/60/90)", "Of first-timers in the period, the share who came back within 30, 60 or 90 days. Only first visits old enough to measure are counted."],
      ["Registration → first participation", "New members (joined 30+ days ago) who have taken part at least once."],
      ["Members needing follow-up", `Riders whose last ride was ${E.RULES.lapseDays}–${E.RULES.lapseLookbackDays} days ago, or who had one ride ${E.RULES.newNoReturnDays}–${E.RULES.lapseLookbackDays} days ago and no second ride.`],
      ["Location", "Abu Dhabi unless the ride is marked Dubai. Historical sessions keep their own AUH/DXB value."],
      ["Ride series", "One series per weekday (Monday Ride, Wednesday Ride, …). Older ride names sit inside each series."],
      ["Repeated copies", "The same form response appended more than once. Only the first copy counts."],
      ["Attendance rate, no-shows", "Not reported: rides take no registrations, and event registrations count as attendance."],
    ];
    return `<div class="grid">
      <section class="card c7"><h2>How each figure is calculated</h2><p class="lead">Rules agreed on 30 Sep and 1 Oct 2026. The same calculations run on the live data every time this page loads.</p>
        <div class="tw"><table><thead><tr><th>Figure</th><th>Rule</th></tr></thead><tbody>${defs.map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td>${esc(b)}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="card c5"><h2>About this data</h2>
        <dl class="kv"><dt>Data mode</dt><dd>${state.demo === "error" ? "No data" : state.demo === "cached" ? "Cached snapshot" : m.mode === "sample" ? "Sample data (synthetic, anonymised)" : m.mode === "copy" ? "Offline copy of the workbook (not live)" : "Live snapshot"}</dd>
          <dt>Data as of</dt><dd>${dayLabel(ASOF)}</dd><dt>Last refreshed</dt><dd>${esc(fmtRefreshed())}</dd>
          <dt>Members</dt><dd>${nf(PP.members.length)}</dd><dt>Activity rows</dt><dd>${nf(PP.rows.length)}</dd><dt>Historical ride sessions</dt><dd>${nf(PP.historyRides.length)}</dd>
          <dt>Source</dt><dd>${m.mode === "sample" ? "Generated to mirror the structure and the problems of WMF_Community_Master_System_Integrated.xlsx. No real member appears." : "WMF database (imported once from WMF_Community_Master_System_Integrated.xlsx; new scans and sign-ups are added live)"}</dd>
          <dt>Your view</dt><dd>${esc(ROLE_TEXT[state.role])}${state.role === "sponsor" ? ": aggregate figures only, counts under 5 shown as <5" : ""}</dd></dl>
        <h2 style="margin-top:18px">Known limitations</h2>
        <ul class="muted" style="padding-left:18px;margin:6px 0 0">
          <li>Ride headcounts after the historical summary ends include registered riders only.</li>
          <li>Event attendance is not recorded; registrations stand in for it.</li>
          <li>QR codes are not emailed by the app. New members see and download their code on the registration page.</li>
          <li>Viewer and sponsor accounts receive anonymised data: no names or emails reach their browser.</li>
        </ul></section>
      
      </div>`;
  }

  // ---------------- shell ----------------
  function fmtRefreshed() {
    const r = (activeP().meta || {}).refreshed; if (!r) return "—";
    const d = r.slice(0, 10), t = r.slice(11, 16);
    if (state.demo === "cached") return `${dayLabel(d)}, 13:00 (refresh at ${t} failed)`;
    return `${dayLabel(d)}, ${t}`;
  }
  function renderStatus() {
    const pill = $("#modePill");
    const mode = state.demo === "error" ? ["pill-error", "No data"] : state.demo === "cached" ? ["pill-cached", "Cached data"] : P.meta.mode === "sample" ? ["pill-mode", "Sample data"] : P.meta.mode === "copy" ? ["pill-cached", "Workbook copy (offline)"] : ["pill-live", "Live data"];
    pill.className = "pill " + mode[0]; pill.textContent = mode[1];
    $("#refreshed").textContent = "Last refreshed " + fmtRefreshed();
    $("#footMeta").textContent = `Viewing as ${ROLE_TEXT[state.role]} · data as of ${dayLabel(ASOF)}`;
  }
  function renderNav() {
    const hiddenFor = state.role === "sponsor" ? ["qr", "quality"] : [];
    if (hiddenFor.includes(state.page)) state.page = "overview";
    $("#nav").innerHTML = PAGES.filter(([k]) => !hiddenFor.includes(k)).map(([k, l]) => `<button data-page="${k}" ${state.page === k ? 'aria-current="page"' : ""}>${esc(l)}</button>`).join("");
  }
  function activeFilterText() {
    const f = state.f, parts = [];
    if (f.location) parts.push(f.location); if (f.kind) parts.push({ ride: "Rides", event: "Events", registration: "Member registrations" }[f.kind]);
    if (f.activity) parts.push(f.activity); if (f.recordType) parts.push(f.recordType); if (f.status) parts.push(f.status);
    if (f.activeStatus) parts.push(f.activeStatus + " members"); if (f.memberType) parts.push(f.memberType + " members"); if (f.source) parts.push(f.source);
    return parts.join(", ");
  }
  function fillFilterOptions() {
    const PP = activeP();
    const acts = new Set(), srcs = new Set(["Historical summary"]);
    for (const r of PP.rows) { if (r.kind === "ride" || r.kind === "event") acts.add(r.activity); srcs.add(r.source); }
    for (const h of PP.historyRides) acts.add(h.series);
    for (const h of PP.historyEvents) acts.add(h.name);
    const rides = [...acts].filter((a) => / Ride$/.test(a)).sort(), evs = [...acts].filter((a) => !/ Ride$/.test(a)).sort();
    $("#fActivity").innerHTML = `<option value="">All activities</option><optgroup label="Rides">${rides.map((a) => `<option>${esc(a)}</option>`).join("")}</optgroup><optgroup label="Events">${evs.map((a) => `<option>${esc(a)}</option>`).join("")}</optgroup>`;
    $("#fSource").innerHTML = `<option value="">All sources</option>` + [...srcs].sort().map((s) => `<option>${esc(s)}</option>`).join("");
    $("#fActivity").value = state.f.activity; $("#fSource").value = state.f.source;
  }
  function syncPeriodControls() {
    const t = state.f.periodType, opts = periodOptions(t);
    $("#fPeriodWrap").hidden = !opts.length; $("#fFromWrap").hidden = $("#fToWrap").hidden = t !== "custom";
    $("#fPeriodLabel").textContent = { month: "Month", quarter: "Quarter", year: "Year" }[t] || "";
    if (opts.length) {
      if (!opts.some(([v]) => v === state.f.period)) state.f.period = opts[0][0];
      $("#fPeriod").innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      $("#fPeriod").value = state.f.period;
    }
    if (t === "custom") { if (!state.f.from) state.f.from = H.addDays(ASOF, -29); if (!state.f.to) state.f.to = ASOF; $("#fFrom").value = state.f.from; $("#fTo").value = state.f.to; }
  }
  function render() {
    renderNav(); renderStatus(); hideTip();
    const pageEl = $("#page");
    try { location.replace("#" + state.page); } catch (e) { /* hash not allowed */ }
    if (state.demo === "loading") { $("#banner").innerHTML = ""; pageEl.innerHTML = skeleton(); return; }
    if (state.demo === "error") {
      $("#banner").innerHTML = "";
      pageEl.innerHTML = `<section class="card"><div class="alert crit"><span class="ic" aria-hidden="true">!</span><span><b>The dashboard couldn't read its data.</b> The latest snapshot file is missing or unreadable, and no earlier snapshot is available. No figures are shown, so nothing on this page can be out of date.</span></div>
        <h2 style="margin-top:14px">What to do</h2><ol class="muted" style="padding-left:20px"><li>Open the snapshot flow's run history in Power Automate and check the last run.</li><li>If the workbook was open for editing in the desktop app, close it and run the flow again.</li><li>If it still fails, send the run's error message to the administrator.</li></ol>
        ${state.page === "about" ? pageAbout() : `<button class="btn" data-act="demo" data-v="normal">Back to normal view</button>`}</section>`;
      return;
    }
    recompute();
    syncExport();
    const f = state.f, ft = activeFilterText();
    const notes = [];
    if (ft) notes.push(`Filtered: ${ft}.`);
    if ((f.activeStatus || f.memberType) && cur.kpis) notes.push("Member filters leave out historical headcounts, which have no names.");
    $("#fnote").textContent = notes.join(" ");
    $("#banner").innerHTML = state.demo === "empty" ? `<div class="alert warn"><span class="ic" aria-hidden="true">!</span><span><b>The snapshot has no records.</b> The workbook was read successfully but its tables are empty. Check that the table names have not changed.</span></div>` : "";
    const pages = { overview: [pageOverview, mountOverview], performance: [pagePerformance, mountPerformance], members: [pageMembers, mountMembers], qr: [pageQR, mountQR], quality: [pageQuality, null], reports: [pageReports, mountReports], about: [pageAbout, null] };
    const [html, mount] = pages[state.page];
    pageEl.innerHTML = html();
    if (mount) mount();
    $("#filters").hidden = ["about", "quality", "qr", "reports"].includes(state.page);
  }
  const skeleton = () => `<div class="hero"><div class="card"><div class="skel" style="height:22px;width:50%"></div><div class="skel" style="height:64px;width:40%;margin-top:14px"></div></div><div class="card"><div class="tiles">${'<div class="skel" style="height:78px"></div>'.repeat(6)}</div></div></div><div class="card" style="margin-top:14px"><div class="skel" style="height:220px"></div></div><p class="muted" role="status">Loading the latest snapshot…</p>`;

  // ---------------- monthly Excel export ----------------
  // months of the selected period; a single month exports the 12 months ending with it, so there is a trend
  function exportRange() {
    const r = range || rangeOf(state.f.periodType, state.f.period, state.f.from, state.f.to);
    let a = r.start.slice(0, 7), b = (r.end < ASOF ? r.end : ASOF).slice(0, 7);
    if (H.monthsBetween(a, b).length < 2) a = H.addMonths(b, -11);
    return { from: a, to: b };
  }
  function exportHref() { const x = exportRange(); return `/api/wmf/monthly.xlsx?from=${x.from}&to=${x.to}`; }
  function syncExport() {
    const el = $("#exportMonthly"); if (!el) return;
    const x = exportRange(); el.href = exportHref();
    el.title = `Excel: attendance per month for rides and events, plus impact (${monLabel(x.from, true)} – ${monLabel(x.to, true)})`;
  }
  function exportBox() {
    const x = exportRange();
    return `<section class="card c12 noprint"><div class="card-head"><div><h2>Export attendance per month</h2><p class="lead">Excel file with one row per month (${esc(monLabel(x.from, true))} – ${esc(monLabel(x.to, true))}): ride sessions and attendance, events and participation, total attendance, unique, new and returning participants, active members, plus ride-by-ride and event-by-event sheets and an Impact sheet. Change the Period filter above to change the months.</p></div>
      <a class="btn primary" href="${esc(exportHref())}">Download Excel</a></div></section>`;
  }

  // ---------------- clipboard ----------------
  async function copyText(text, toastId) {
    const t = $("#" + toastId);
    try { await navigator.clipboard.writeText(text); if (t) t.textContent = "Copied"; }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("aria-label", "Copy this text"); ta.style.cssText = "width:100%;height:160px;margin-top:8px"; t.after(ta); ta.select();
      if (t) t.textContent = "Select the text below and copy it";
    }
    setTimeout(() => { if (t) t.textContent = ""; }, 4000);
  }
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\n");
  function filteredCSV(cur) {
    if (state.role === "sponsor") return toCSV([["Month", "Ride attendance", "Qualifying participations", "Event participation", "New members"], ...cur.trend.filter((t) => t.inPeriod).map((t) => [t.month, t.rideAttendance, t.qualifying, t.eventParticipation, t.newMembers])]);
    const named = state.role === "admin" || state.role === "coordinator";
    const head = ["Record ID", "Date", "Record type", "Activity", "Ride series", "Location", "Status", "Source", "Member ID", named ? "Member" : null].filter(Boolean);
    return toCSV([head, ...cur.rows.map((r) => [r.recordId || "", r.d, r.recordType, H.clean(r.activityName), r.series || "", r.location, r.status, r.source, r.member ? r.member.memberId : "", named ? (r.member ? r.member.label : "") : null].filter((x) => x !== null))]);
  }
  function dqCSV() {
    const rows = [["Check", "Severity", "Table", "Record", "Member", "Date", "Field", "Current value", "Proposed correction", "Admin decision"]];
    for (const c of activeP().quality.checks) for (const x of c.items) rows.push([c.label, c.severity, x.table, x.ref, x.label || "", x.date || "", x.field, x.current || "", x.proposed, ""]);
    return toCSV(rows);
  }
  function reportText() {
    const el = $("#report"); return el ? el.innerText : "";
  }

  // ---------------- events ----------------
  function bind() {
    $("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (!b) return; state.page = b.dataset.page; render(); $("#main").focus({ preventScroll: true }); });
    $("#nav").addEventListener("keydown", (e) => { if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return; const bs = [...$("#nav").querySelectorAll("button")]; const i = bs.indexOf(document.activeElement); if (i < 0) return; const n = bs[(i + (e.key === "ArrowRight" ? 1 : bs.length - 1)) % bs.length]; n.focus(); });
    
    const bindF = (id, key, after) => $(id).addEventListener("change", (e) => { state.f[key] = e.target.value; if (after) after(); render(); });
    bindF("#fPeriodType", "periodType", syncPeriodControls); bindF("#fPeriod", "period"); bindF("#fFrom", "from"); bindF("#fTo", "to");
    bindF("#fLocation", "location"); bindF("#fKind", "kind"); bindF("#fActivity", "activity"); bindF("#fRecordType", "recordType");
    bindF("#fStatus", "status"); bindF("#fActive", "activeStatus"); bindF("#fMemberType", "memberType"); bindF("#fSource", "source");
    $("#moreBtn").addEventListener("click", () => { const m = $("#more"), open = m.hidden; m.hidden = !open; $("#moreBtn").setAttribute("aria-expanded", String(open)); });
    $("#resetBtn").addEventListener("click", resetFilters);
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.dataset.act;
      if (act === "reset") resetFilters();
      if (act === "table") { state.showTable[b.dataset.id] = !state.showTable[b.dataset.id]; render(); const nb = document.querySelector(`[data-act="table"][data-id="${b.dataset.id}"]`); if (nb) nb.focus(); }
      if (act === "rtype") { state.report.type = b.dataset.v; state.report.period = ""; render(); }
      if (act === "copyCSV") copyText(state.page === "reports" ? filteredCSV(buildReport().c) : filteredCSV(cur), state.page === "reports" ? "rToast" : "oToast");
      if (act === "copyReport") copyText(reportText(), "rToast");
      if (act === "copyDQ") copyText(dqCSV(), "dqToast");
      if (act === "demo") { state.demo = b.dataset.v; fillFilterOptions(); syncPeriodControls(); render(); if (state.demo === "loading") setTimeout(() => { if (state.demo === "loading") { state.demo = "normal"; render(); } }, 1600); }
    });
    document.addEventListener("change", (e) => { if (e.target.id === "rPeriod") { state.report.period = e.target.value; render(); } });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (state.demo !== "loading" && state.demo !== "error") { const pages = { overview: mountOverview, performance: mountPerformance, members: mountMembers, qr: mountQR, reports: mountReports }; const m = pages[state.page]; if (m) m(); } }, 150); });
  }
  function resetFilters() {
    const t = state.f.periodType, p = state.f.period, from = state.f.from, to = state.f.to;
    state.f = { periodType: t, period: p, from, to, location: "", kind: "", activity: "", recordType: "", status: "", activeStatus: "", memberType: "", source: "" };
    for (const [id, k] of [["#fLocation", "location"], ["#fKind", "kind"], ["#fActivity", "activity"], ["#fRecordType", "recordType"], ["#fStatus", "status"], ["#fActive", "activeStatus"], ["#fMemberType", "memberType"], ["#fSource", "source"]]) $(id).value = "";
    render();
  }

  // ---------------- boot ----------------
  function boot() {
    
    $("#page").innerHTML = skeleton();
    setTimeout(() => {
      try {
        DATA = window.WMF_DATA;
        if (!DATA || !Array.isArray(DATA.activity) || !Array.isArray(DATA.members)) throw new Error("The snapshot is missing its member or activity table.");
        P = E.prepare(DATA);
        ASOF = (DATA.meta && DATA.meta.asOf) || new Date().toISOString().slice(0, 10);
        P_EMPTY = E.prepare({ meta: DATA.meta, members: [], activity: [], historyRides: [], historyEvents: [] });
        state.f.period = +ASOF.slice(8, 10) <= 7 ? H.addMonths(ASOF.slice(0, 7), -1) : ASOF.slice(0, 7);   // first week of a month: open on the month just finished
        fillFilterOptions(); syncPeriodControls(); bind(); render();
      } catch (err) {
        P = { meta: {} }; state.demo = "error";
        $("#page").innerHTML = `<section class="card"><div class="alert crit"><span class="ic">!</span><span><b>The dashboard couldn't read its data.</b> ${esc(err.message)} No figures are shown.</span></div></section>`;
      }
    }, 60);
  }
  boot();
})();
