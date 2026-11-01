/* Ride-lead scanner: camera QR scanning, name check-in, walk-ins, and an offline queue. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const QKEY = "wmf.scanQueue";
  const ctx = () => ({ activityId: $("#activity").value, date: $("#date").value });
  let scanner = null, lastCode = "", lastAt = 0, busy = false;

  // ---------- feedback ----------
  function beep(ok) {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
      o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(a.destination); g.gain.value = 0.15; o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.35));
    } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
  }
  function show(r) {
    const el = $("#result"); el.hidden = false;
    const cls = r.status === "ok" ? "ok" : r.status === "duplicate" ? "dup" : r.status === "queued" ? "dup" : "err";
    el.className = "scan-result " + cls;
    if (r.status === "ok") el.innerHTML = `<b>✓ ${esc(r.name || r.memberId)}</b><span>${esc(r.memberId)} · ${esc(r.series)}${r.rides === 1 ? " · first ride, welcome!" : r.rides ? ` · ride ${r.rides}` : ""}</span>`;
    else if (r.status === "duplicate") el.innerHTML = `<b>Already checked in</b><span>${esc(r.name || r.memberId)} · ${esc(r.series || "")}</span>`;
    else if (r.status === "queued") el.innerHTML = `<b>Saved on this phone</b><span>${esc(r.code)}: no connection. It will be sent automatically.</span>`;
    else el.innerHTML = `<b>Not checked in</b><span>${esc(r.message || "Try again.")}</span>`;
    beep(r.status === "ok" || r.status === "duplicate" || r.status === "queued");
    if (r.status === "ok" || r.status === "duplicate") addLog(r);
  }
  function addLog(r) {
    const log = $("#log"); if (log.querySelector(".muted")) log.innerHTML = "";
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(r.name || r.memberId)} <span class="muted">${esc(r.memberId)}</span></span><span class="badge ${r.status === "ok" ? "good" : ""}">${r.status === "ok" ? "Checked in" : "Already in"} · ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>`;
    log.prepend(li);
  }

  // ---------- server calls with an offline queue ----------
  const readQ = () => { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch (e) { return []; } };
  const writeQ = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) { /* storage blocked */ } showQ(); };
  function showQ() { const n = readQ().length, el = $("#queue"); el.hidden = !n; el.textContent = n ? `${n} scan${n > 1 ? "s" : ""} waiting to be sent…` : ""; }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    if (r.status === 401) { location.href = "/login?next=/scan"; throw new Error("signed out"); }
    if (r.status >= 500) throw new Error("server");
    return r.json();
  }
  async function sendScan(code) {
    const body = { code, ...ctx() };
    if (!body.activityId) return show({ status: "error", message: "Choose a ride first." });
    try { show(await post("/api/scan", body)); }
    catch (e) { if (e.message === "signed out") return; const q = readQ(); q.push(body); writeQ(q); show({ status: "queued", code }); }
  }
  async function flush() {
    const q = readQ(); if (!q.length) return;
    const left = [];
    for (const item of q) { try { const r = await post("/api/scan", item); if (r.status === "ok") addLog(r); } catch (e) { left.push(item); } }
    writeQ(left);
  }
  window.addEventListener("online", flush);
  setInterval(flush, 20000);
  showQ(); flush();

  // today's calendar rides: tap to choose that ride
  document.querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => { $("#activity").value = b.dataset.slot; }));

  // ---------- camera ----------
  function onScan(text) {
    const now = Date.now();
    if (busy || (text === lastCode && now - lastAt < 4000)) return; // the same code stays in view: ignore repeats
    lastCode = text; lastAt = now; busy = true;
    sendScan(text).finally(() => setTimeout(() => { busy = false; }, 800));
  }
  $("#start").addEventListener("click", async () => {
    if (!window.Html5Qrcode) return show({ status: "error", message: "The scanner didn't load. Refresh the page." });
    scanner = scanner || new Html5Qrcode("reader", { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
    try {
      await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } }, onScan, () => {});
      $("#start").hidden = true; $("#stop").hidden = false;
    } catch (e) {
      show({ status: "error", message: "Camera unavailable. Allow camera access for this site, or check in by name below." });
    }
  });
  $("#stop").addEventListener("click", async () => { try { await scanner.stop(); } catch (e) { /* already stopped */ } $("#start").hidden = false; $("#stop").hidden = true; });

  // ---------- name search ----------
  let t;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(async () => {
      if (q.length < 2) { $("#hitsList").innerHTML = ""; return; }
      const r = await fetch("/api/members/search?q=" + encodeURIComponent(q), { credentials: "same-origin" }).then((x) => x.json()).catch(() => []);
      $("#hitsList").innerHTML = r.length ? r.map((m) => `<li><span><b>${esc(m.name)}</b> <span class="muted">${esc(m.memberId)} ${esc(m.hint)}</span></span><button class="btn tblbtn" data-id="${esc(m.memberId)}">Check in</button></li>`).join("")
        : `<li class="muted">No match. Use “Walk-in” below.</li>`;
    }, 250);
  });
  $("#hitsList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-id]"); if (!b) return;
    b.disabled = true;
    try { show(await post("/api/checkin", { memberId: b.dataset.id, ...ctx() })); } catch (x) { show({ status: "error", message: "No connection. Try again." }); }
    b.disabled = false;
  });
  $("#walkin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), body = Object.fromEntries(f.entries());
    try {
      const r = await post("/api/walkin", { ...body, ...ctx() });
      show(r);
      if (r.status === "ok" || r.status === "duplicate") { e.target.reset(); if (r.created) $("#result").insertAdjacentHTML("beforeend", `<span>New member ${esc(r.memberId)}. <a href="/members/${encodeURIComponent(r.memberId)}">Show their QR code</a></span>`); }
    } catch (x) { show({ status: "error", message: "No connection. Try again." }); }
  });
})();
