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
  const STAFF = !!document.querySelector(".wc[data-staff]");
  const qm = /^(\d{4})-(\d{2})$/.exec(new URLSearchParams(location.search).get("m") || "");
  let cur = qm ? { y: +qm[1], m: +qm[2] - 1 } : (() => { const d = K.parse(today); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; })();
  const back = () => `/calendar?m=${cur.y}-${pad(cur.m + 1)}`;
  const postBtn = (action, fields, label, cls, confirm) => `<form method="post" action="${esc(action)}" style="display:inline">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="btn ${cls || ""}"${confirm ? ` data-confirm="${esc(confirm)}"` : ""}>${label}</button></form>`;

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
      g += `<div class="wc-cell${out ? " out" : ""}${d === today ? " is-today" : ""}" data-d="${d}"><div class="wc-num"><span>${K.parse(d).getUTCDate()}</span>${STAFF ? `<button class="wc-add" data-add="${d}" aria-label="Add on ${fmt(d)}">+</button>` : ""}</div><div class="wc-items">${items.map((o) => pill(o, d)).join("")}</div></div>`;
    }
    $("#wc-grid").innerHTML = g;
    let ag = "";
    for (let d = first; d <= last; d = K.add(d, 1)) {
      const items = map[d] || [];
      if (!items.length && d !== today) continue;
      ag += `<div class="wc-day${d === today ? " is-today" : ""}" id="ag-${d}"><div class="wc-d"><small>${DAYS[K.dow(d)].slice(0, 3)}</small><strong>${K.parse(d).getUTCDate()}</strong>${STAFF ? `<button class="wc-add" data-add="${d}" aria-label="Add on ${fmt(d)}">+</button>` : ""}</div><div class="wc-items">${items.length ? items.map((o) => pill(o, d)).join("") : '<span class="muted">Nothing planned</span>'}</div></div>`;
    }
    $("#wc-agenda").innerHTML = ag || '<div class="empty">Nothing planned this month yet.</div>';
  }
  const pop = $("#wc-pop"), card = pop.querySelector(".wc-card"), cardHtml = card.innerHTML;
  const reset = () => { card.classList.remove("wide"); card.innerHTML = cardHtml; };
  /** Staff: load the edit / add form into the pop-up, so changes happen on the calendar itself. */
  function loadForm(url, title) {
    card.classList.add("wide");
    card.innerHTML = `<div class="wc-head"><button class="wc-x" data-close aria-label="Close">×</button><div class="wc-eyebrow">Edit the calendar</div><h2>${esc(title)}</h2></div><div class="wc-form"><p class="muted">Loading…</p></div>`;
    pop.hidden = false;
    fetch(url, { credentials: "same-origin" }).then((r) => (r.ok ? r.text() : Promise.reject())).then((html) => {
      const box = card.querySelector(".wc-form"); box.innerHTML = html; const h2 = box.querySelector("h2"); if (h2) h2.remove();
      const f = box.querySelector("input[name=title]"); if (f) f.focus();
    }).catch(() => { card.querySelector(".wc-form").innerHTML = '<p class="muted">Could not load the form. Refresh the page.</p>'; });
  }
  function open(k) {
    reset();
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
    if (STAFF && a.id) {
      acts.push(`<button class="btn" type="button" data-edit="${a.id}">Edit</button>`);
      acts.push(postBtn(`/calendar/items/${a.id}/date`, o.cancel ? { date: o.date, undo: "1", back: back() } : { date: o.date, back: back() }, o.cancel ? "Bring back this date" : a.r ? "Cancel this date" : "Mark cancelled", ""));
      acts.push(postBtn(`/calendar/items/${a.id}/delete`, { back: back() }, "Delete", "danger", `Delete "${a.t}"${a.r ? " and every date it repeats" : ""}?`));
    }
    $("#wc-pop-actions").innerHTML = acts.join("");
    pop.hidden = false; pop.querySelector(".wc-x").focus();
  }
  const phone = window.matchMedia("(max-width:760px)");
  document.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) { e.preventDefault(); loadForm(`/calendar/items/new?embed=1&date=${add.dataset.add}&back=${encodeURIComponent(back())}`, "Add on " + fmt(add.dataset.add, { wd: 1, y: 1 })); return; }
    const ed = e.target.closest("[data-edit]");
    if (ed) { e.preventDefault(); loadForm(`/calendar/items/${ed.dataset.edit}?embed=1&back=${encodeURIComponent(back())}`, "Edit entry"); return; }
    if (e.target.closest("[data-close]")) { pop.hidden = true; reset(); return; }
    const cell = e.target.closest(".wc-cell");
    if (cell && phone.matches) {
      if (!cell.classList.contains("out") && cell.querySelector(".wc-pill")) {
        document.querySelectorAll(".wc-cell.sel").forEach((x) => x.classList.remove("sel")); cell.classList.add("sel");
        const card = document.getElementById("ag-" + cell.dataset.d); if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }
    const p = e.target.closest(".wc-pill"); if (p) open(p.dataset.k);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { pop.hidden = true; reset(); } });
  const step = (n) => { const d = new Date(Date.UTC(cur.y, cur.m + n, 1, 12)); cur = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; render(); };
  $("#wc-prev").onclick = () => step(-1); $("#wc-next").onclick = () => step(1);
  $("#wc-today").onclick = () => { const d = K.parse(today); cur = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; render(); };
  $("#wc-grid").innerHTML = '<div class="empty" style="grid-column:1/-1">Loading…</div>';
  fetch("/api/calendar.json", { credentials: "same-origin" }).then((r) => r.json()).then((j) => {
    DATA = j.items || [];
    if (!DATA.some((a) => a.c === "track_closure")) { const ch = document.querySelector(".wc-chip.c-track_closure"); if (ch) ch.remove(); }
    render();
  }).catch(() => { $("#wc-grid").innerHTML = '<div class="empty" style="grid-column:1/-1">The calendar could not load. Refresh the page.</div>'; });
})();
