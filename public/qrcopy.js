/* Corporate participants: "Draft email" copies the person's QR picture, then Outlook opens the ready-written email; paste it in with Ctrl+V. */
(function () {
  "use strict";
  function note(text, ok) {
    var n = document.getElementById("qr-note");
    if (!n) { n = document.createElement("div"); n.id = "qr-note"; n.setAttribute("role", "status"); document.body.appendChild(n); }
    n.textContent = text; n.className = ok ? "ok" : "warn"; n.hidden = false;
    clearTimeout(n._t); n._t = setTimeout(function () { n.hidden = true; }, 9000);
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-qr-copy]");
    if (!a) return;
    if (!(navigator.clipboard && window.ClipboardItem)) { note("Your browser can't copy pictures: open the person's page and use Download PNG, then attach it.", false); return; }
    var png = fetch(a.getAttribute("data-qr-copy"), { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("load"); return r.blob(); })
      .then(function (b) { return new Blob([b], { type: "image/png" }); });
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      .then(function () { note("QR picture copied. In the Outlook email, click on the empty line under "Here is your personal QR code" and press Ctrl+V, then Send.", true); a.classList.add("done"); })
      .catch(function () { note("Couldn't copy the QR picture. The email still has their QR link; or use Download PNG on their page and attach it.", false); });
  });
})();
