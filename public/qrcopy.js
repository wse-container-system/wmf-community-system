/* Corporate participants: "Draft email" downloads a ready email (QR picture inside) for the Outlook app. */
(function () {
  "use strict";
  function note(text) {
    var n = document.getElementById("qr-note");
    if (!n) { n = document.createElement("div"); n.id = "qr-note"; n.setAttribute("role", "status"); document.body.appendChild(n); }
    n.textContent = text; n.className = "ok"; n.hidden = false;
    clearTimeout(n._t); n._t = setTimeout(function () { n.hidden = true; }, 9000);
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-draft]");
    if (!a) return;
    a.classList.add("done"); a.textContent = "Downloaded";
    note("Email downloaded. Open it (from your downloads) and Outlook shows it ready, with the QR picture: press Send.");
  });
})();
