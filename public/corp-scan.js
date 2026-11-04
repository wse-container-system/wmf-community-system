/* Corporate scanner: ride leads scan participants' personal QR codes (CORP-…) into today's session. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var scanner = null, last = "", lastAt = 0, busy = false;
  function beep(ok) {
    try { var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(a.destination); g.gain.value = 0.15; o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.35)); } catch (e) { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [60, 60, 60]);
  }
  function show(r) {
    var el = $("#result"); el.hidden = false;
    el.className = "scan-result " + (r.status === "ok" ? "ok" : r.status === "duplicate" ? "dup" : "err");
    el.innerHTML = r.status === "ok" ? "<b>✓ " + esc(r.name) + "</b><span>" + esc(r.pid) + " · session " + esc(r.total) + "</span>"
      : r.status === "duplicate" ? "<b>Already checked in</b><span>" + esc(r.name) + "</span>" : "<b>Not checked in</b><span>" + esc(r.message || "Try again.") + "</span>";
    beep(r.status !== "error");
    if (r.status !== "error") {
      var log = $("#log"); if (log.querySelector(".muted")) log.innerHTML = "";
      var li = document.createElement("li");
      li.innerHTML = "<span>" + esc(r.name) + ' <span class="muted">' + esc(r.pid) + '</span></span><span class="badge ' + (r.status === "ok" ? "good" : "") + '">' + (r.status === "ok" ? "Checked in" : "Already in") + "</span>";
      log.prepend(li);
    }
  }
  function onScan(text) {
    var now = Date.now();
    if (busy || (text === last && now - lastAt < 4000)) return;
    last = text; lastAt = now; busy = true;
    fetch("/api/corp/scan", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ code: text, session: $("#corpSession").value }) })
      .then(function (r) { if (r.status === 401) { location.href = "/login?next=/corporate/scan"; throw new Error("signed out"); } return r.json(); })
      .then(show, function () { show({ status: "error", message: "No connection. Try again." }); })
      .finally(function () { setTimeout(function () { busy = false; }, 800); });
  }
  // typed ID for someone who forgot their code
  var byId = $("#byId");
  if (byId) byId.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("#pidInput").value.trim(); if (!v) return;
    last = ""; onScan(v); $("#pidInput").value = "";
  });
  $("#start").addEventListener("click", function () {
    if (!window.Html5Qrcode) return show({ status: "error", message: "The scanner didn't load. Refresh the page." });
    scanner = scanner || new Html5Qrcode("reader", { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
    scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: function (w, h) { var s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } }, onScan, function () {})
      .then(function () { $("#start").hidden = true; $("#stop").hidden = false; }, function (e) { show({ status: "error", message: window.cameraHelp ? window.cameraHelp(e) : "Camera unavailable. Allow camera access for this site." }); });
  });
  $("#stop").addEventListener("click", function () { (scanner ? scanner.stop() : Promise.resolve()).catch(function () {}).then(function () { $("#start").hidden = false; $("#stop").hidden = true; }); });
})();
