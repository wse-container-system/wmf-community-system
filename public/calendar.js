/* WMF calendar page: month grid on larger screens, compact grid plus day list on phones. Data: /api/calendar.json */
(function () {
  "use strict";
  const K = window.WMFCalendar;
  const $ = (s) => document.querySelector(s);
  const CAT = { wmf_ride: "WMF Ride", wmf_event: "WMF Event", generic_event: "Other event / key date", track_closure: "Track closure" };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });
  const t12 = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return (h % 12 || 12) + (m ? ":" + pad(m) : "") + " " + (h >= 12 ? "PM" : "AM"); };
  const fmt = (s, o) => { const d = K.parse(s); return (o && o.wd ? DAYS[d.getUTCDay()].slice(0, 3) + " " : "") + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()].slice(0, 3) + (o && o.y ? " " + d.getUTCFullYear() : ""); };
  const safeUrl = (u) => { if (!u) return ""; try { const x = new URL(u, location.origin); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch (e) { return ""; } };

  let DATA = [], index = {};
  let cur = (() => { const d = K.parse(today); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; })();

  function pill(o, day) {
    const a = o.a, span = K.diff(o.end, o.date) + 1, n = K.diff(day, o.date) + 1, k = DATA.indexOf(a) + "@" + o.date;
    index[k] = o;
    const tbc = a.status === "Tentative" || (a.c === "wmf_ride" && !a.st);
    const tag = o.cancel ? " · Cancelled" : a.signup ? '<span class="wc-jn">Sign up</span>' : safeUrl(a.u) ? '<span class="wc-jn">↗ Join</span>' : "";
    return `<button class="wc-pill c-${a.c}${tbc ? " tbc" : ""}${o.cancel ? " cancel" : ""}" data-k="${k}">${a.st ? `<b>${t12(a.st)}</b>` : ""}${esc(a.t)}${span > 1 ? `<span class="wc-span">${n}/${span}</span>` : ""}${tag}</button>`;
  }
  function render() {
    index = {};
    const { y, m } = cur;
    $("#wc-month").textContent = MONTHS[m] + " " + y;
    const first = `${y}-${pad(m + 1)}-01`, last = K.iso(new Date(Date.UTC(y, m + 1, 0, 12)));
    const from = K.monday(first), to = K.add(K.monday(last), 6), map = K.build(DATA, from, to);
    let g = "";
    for (let d = from; d <= to; d = K.add(d, 1)) {
      const out = K.parse(d).getUTCMonth() !== m, items = map[d] || [];
      g += `<div class="wc-cell${out ? " out" : ""}${d === today ? " is-today" : ""}" data-d="${d}"><div class="wc-num"><span>${K.parse(d).getUTCDate()}</span></div><div class="wc-items">${items.map((o) => pill(o, d)).join("")}</div></div>`;
    }
    $("#wc-grid").innerHTML = g;
    let ag = "";
    for (let d = first; d <= last; d = K.add(d, 1)) {
      const items = map[d] || [];
      if (!items.length && d !== today) continue;
      ag += `<div class="wc-day${d === today ? " is-today" : ""}" id="ag-${d}"><div class="wc-d"><small>${DAYS[K.dow(d)].slice(0, 3)}</small><strong>${K.parse(d).getUTCDate()}</strong></div><div class="wc-items">${items.length ? items.map((o) => pill(o, d)).join("") : '<span class="muted">Nothing planned</span>'}</div></div>`;
    }
    $("#wc-agenda").innerHTML = ag || '<div class="empty">Nothing planned this month yet.</div>';
  }
  const pop = $("#wc-pop");
  function open(k) {
    const o = index[k]; if (!o) return;
    const a = o.a;
    $("#wc-pop-head").className = "wc-head c-" + a.c;
    $("#wc-pop-cat").textContent = CAT[a.c];
    $("#wc-pop-title").textContent = a.t;
    const rows = [["Date", o.end > o.date ? fmt(o.date, { wd: 1 }) + " – " + fmt(o.end, { wd: 1, y: 1 }) : fmt(o.date, { wd: 1, y: 1 })],
      ["Time", a.st ? t12(a.st) + (a.et ? " – " + t12(a.et) : "") : "To be confirmed"], ["Location", a.loc || "To be confirmed"]];
    if (a.fee) rows.push(["Fee", a.fee + " (pay online after signing up)"]);
    if (a.r) rows.push(["Repeats", a.r.freq === "monthly" ? "Monthly" : "Every " + (a.r.interval > 1 ? a.r.interval + " weeks, " : "") + (a.r.weekdays || []).map((d) => DAYS[d]).join(", ")]);
    if (o.cancel) rows.unshift(["Status", "Cancelled"]); else if (a.status === "Tentative") rows.unshift(["Status", "To be confirmed"]);
    $("#wc-pop-body").innerHTML = rows.map(([k2, v]) => `<div><dt>${k2}</dt><dd>${esc(v)}</dd></div>`).join("");
    const acts = [];
    if (!o.cancel && a.signup) acts.push(`<a class="btn primary big" href="${esc(a.signup)}">Sign up</a>`);
    const ju = safeUrl(a.u);
    if (!o.cancel && ju) acts.push(`<a class="btn big" href="${esc(ju)}" target="_blank" rel="noopener noreferrer">${/strava\./i.test(ju) ? "Join on Strava ↗" : "Open link ↗"}</a>`);
    $("#wc-pop-actions").innerHTML = acts.join("");
    pop.hidden = false; pop.querySelector(".wc-x").focus();
  }
  const phone = window.matchMedia("(max-width:760px)");
  document.addEventListener("click", (e) => {
    const cell = e.target.closest(".wc-cell");
    if (cell && phone.matches) {
      if (!cell.classList.contains("out") && cell.querySelector(".wc-pill")) {
        document.querySelectorAll(".wc-cell.sel").forEach((x) => x.classList.remove("sel")); cell.classList.add("sel");
        const card = document.getElementById("ag-" + cell.dataset.d); if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    const p = e.target.closest(".wc-pill"); if (p) open(p.dataset.k);
    if (e.target.closest("[data-close]")) pop.hidden = true;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.hidden = true; });
  const step = (n) => { const d = new Date(Date.UTC(cur.y, cur.m + n, 1, 12)); cur = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; render(); };
  $("#wc-prev").onclick = () => step(-1); $("#wc-next").onclick = () => step(1);
  $("#wc-today").onclick = () => { const d = K.parse(today); cur = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; render(); };
  $("#wc-grid").innerHTML = '<div class="empty" style="grid-column:1/-1">Loading…</div>';
  fetch("/api/calendar.json").then((r) => r.json()).then((j) => {
    DATA = j.items || [];
    if (!DATA.some((a) => a.c === "track_closure")) { const ch = document.querySelector(".wc-chip.c-track_closure"); if (ch) ch.remove(); }
    render();
  }).catch(() => { $("#wc-grid").innerHTML = '<div class="empty" style="grid-column:1/-1">The calendar could not load. Refresh the page.</div>'; });
})();
