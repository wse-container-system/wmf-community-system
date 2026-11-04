/* Shareable scanner page: WMF / Corporate, camera scanning, typed IDs, and scans kept on the phone when the signal drops. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var card = document.querySelector("[data-token]");
  if (!card) return;
  var token = card.getAttribute("data-token");
  var QKEY = "cd.scanQueue." + token, MKEY = "cd.scanMode", LKEY = "cd.scanLog." + token;
  var today = new Date().toISOString().slice(0, 10);
  var store = {
    get: function (k, d) { try { var v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  // ---------- WMF / Corporate tabs
  var mode = card.getAttribute("data-default");
  var tabs = document.querySelectorAll("[data-mode]");
  function setMode(m) {
    mode = m;
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-mode") === m)); });
    document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== m; });
    store.set(MKEY, m);
  }
  if (tabs.length) { tabs.forEach(function (t) { t.addEventListener("click", function () { setMode(t.getAttribute("data-mode")); }); }); setMode(store.get(MKEY, mode)); }
  // remember the chosen ride / session for the day
  ["#wmfRide", "#corpSession"].forEach(function (id) {
    var el = $(id); if (!el) return;
    var saved = store.get("cd.sel." + id + "." + today, null);
    if (saved && Array.prototype.some.call(el.options, function (o) { return o.value === saved; })) el.value = saved;
    el.addEventListener("change", function () { store.set("cd.sel." + id + "." + today, el.value); });
  });
  var ctx = function () { return { activityId: $("#wmfRide") ? $("#wmfRide").value : "", session: $("#corpSession") ? $("#corpSession").value : "" }; };

  // ---------- feedback and today's list
  function beep(ok) {
    try { var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(a.destination); g.gain.value = 0.15; o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.35)); } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
  }
  var log = store.get(LKEY, { day: today, items: [] });
  if (log.day !== today) log = { day: today, items: [] };
  function drawLog() {
    var ul = $("#log");
    $("#count").textContent = log.items.filter(function (x) { return x.s === "ok"; }).length;
    ul.innerHTML = log.items.length ? log.items.slice(0, 60).map(function (x) {
      return "<li><span>" + esc(x.n) + ' <span class="muted">' + esc(x.i) + '</span></span><span class="badge ' + (x.s === "ok" ? "good" : x.s === "queued" ? "warn" : "") + '">' + (x.s === "ok" ? "In" : x.s === "queued" ? "Saved, not sent" : "Already in") + " · " + esc(x.t) + "</span></li>";
    }).join("") : '<li class="muted">Nobody yet.</li>';
  }
  function remember(r, code) {
    log.items.unshift({ n: r.name || code, i: r.id || "", s: r.status, t: new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) });
    store.set(LKEY, log); drawLog();
  }
  function show(r, code) {
    var el = $("#result"); el.hidden = false;
    el.className = "scan-result " + (r.status === "ok" ? "ok" : r.status === "error" ? "err" : "dup");
    el.innerHTML = r.status === "ok" ? "<b>✓ " + esc(r.name) + "</b><span>" + esc(r.id) + " · " + esc(r.detail || "") + "</span>"
      : r.status === "duplicate" ? "<b>Already checked in</b><span>" + esc(r.name) + "</span>"
      : r.status === "queued" ? "<b>Saved on this phone</b><span>" + esc(code) + ": no signal. It will be sent automatically.</span>"
      : "<b>Not checked in</b><span>" + esc(r.message || "Try again.") + "</span>";
    beep(r.status !== "error");
    if (r.status !== "error") remember(r, code);
  }

  // ---------- sending, with a queue for no signal
  function post(body) {
    return fetch("/s/" + encodeURIComponent(token) + "/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { if (r.status >= 500) throw new Error("server"); return r.json(); });
  }
  function showQ() { var n = store.get(QKEY, []).length, el = $("#queue"); el.hidden = !n; el.textContent = n ? n + " scan" + (n > 1 ? "s" : "") + " waiting for signal…" : ""; }
  function send(code) {
    var body = Object.assign({ code: code }, ctx());
    return post(body).then(function (r) { show(r, code); }, function () { var q = store.get(QKEY, []); q.push(body); store.set(QKEY, q); showQ(); show({ status: "queued" }, code); });
  }
  function flush() {
    var q = store.get(QKEY, []); if (!q.length) return;
    var left = [];
    q.reduce(function (p, item) { return p.then(function () { return post(item).then(function (r) { if (r.status === "ok") remember(r, item.code); }, function () { left.push(item); }); }); }, Promise.resolve())
      .then(function () { store.set(QKEY, left); showQ(); });
  }
  window.addEventListener("online", flush); setInterval(flush, 20000); showQ(); flush(); drawLog();

  // ---------- camera
  var scanner = null, last = "", lastAt = 0, busy = false;
  function onScan(text) {
    var now = Date.now();
    if (busy || (text === last && now - lastAt < 4000)) return; // the same code held in view: ignore repeats
    last = text; lastAt = now; busy = true;
    send(text).finally(function () { setTimeout(function () { busy = false; }, 900); });
  }
  $("#start").addEventListener("click", function () {
    if (!window.Html5Qrcode) return show({ status: "error", message: "The scanner didn't load. Refresh the page." });
    scanner = scanner || new Html5Qrcode("reader", { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
    scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.72); return { width: s, height: s }; } }, onScan, function () {})
      .then(function () { $("#start").hidden = true; $("#stop").hidden = false; }, function () { show({ status: "error", message: "Camera blocked. Allow camera access for this page in your phone's settings, or type the ID below." }); });
  });
  $("#stop").addEventListener("click", function () { (scanner ? scanner.stop() : Promise.resolve()).catch(function () {}).then(function () { $("#start").hidden = false; $("#stop").hidden = true; }); });

  // ---------- typed ID
  $("#byId").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("#idInput").value.trim(); if (!v) return;
    last = ""; send(v); $("#idInput").value = "";
  });
})();
