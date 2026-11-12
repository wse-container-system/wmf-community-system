/* Corporate participants: "Draft email" copies the person's QR picture FIRST, then opens the ready-written email in Outlook on the web.
   (Copying has to finish while this page still has focus, so the Outlook tab opens only after the copy.) */
(function () {
  "use strict";
  function note(html, ok) {
    var n = document.getElementById("qr-note");
    if (!n) { n = document.createElement("div"); n.id = "qr-note"; n.setAttribute("role", "status"); document.body.appendChild(n); }
    n.innerHTML = html; n.className = ok ? "ok" : "warn"; n.hidden = false;
    clearTimeout(n._t); n._t = setTimeout(function () { n.hidden = true; }, 15000);
  }
  function openDraft(href) {
    var w = window.open(href, "_blank");
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } return; }
    note('QR picture copied. <a href="' + href + '" target="_blank" rel="noopener">Open the email in Outlook</a>, click on the empty line under "Here is your personal QR code", press Ctrl+V, then Send.', true);
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-qr-copy]");
    if (!a) return;
    e.preventDefault();
    var href = a.getAttribute("href");
    if (!(navigator.clipboard && window.ClipboardItem)) { note("Your browser can't copy pictures. The email still has their QR link.", false); openDraft(href); return; }
    var png = fetch(a.getAttribute("data-qr-copy"), { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("load"); return r.blob(); })
      .then(function (b) { return new Blob([b], { type: "image/png" }); });
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      .then(function () {
        a.classList.add("done");
        note('QR picture copied. In Outlook, click on the empty line under "Here is your personal QR code", press <b>Ctrl+V</b>, then Send.', true);
        openDraft(href);
      })
      .catch(function () { note("Couldn't copy the QR picture. The email still has their QR link.", false); openDraft(href); });
  });
})();
