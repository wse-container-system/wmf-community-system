/* Number boxes that open their details: one panel open at a time per row; Close or tapping the box again closes it. */
(function () {
  "use strict";
  if (window.__dtReady) return; window.__dtReady = true;
  function close(btn) { var p = document.getElementById(btn.getAttribute("aria-controls")); if (p) p.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  document.addEventListener("click", function (e) {
    var b = e.target.closest(".tile.dt");
    if (b) {
      var open = b.getAttribute("aria-expanded") === "true";
      b.closest(".dt-row").querySelectorAll(".tile.dt").forEach(close);
      if (!open) {
        var p = document.getElementById(b.getAttribute("aria-controls"));
        if (p) { p.hidden = false; b.setAttribute("aria-expanded", "true"); var r = p.getBoundingClientRect(); if (r.top > window.innerHeight - 80) p.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
      }
      return;
    }
    var c = e.target.closest(".dt-close");
    if (c) { var panel = c.closest(".dt-panel"); var btn = document.querySelector('[aria-controls="' + panel.id + '"]'); if (btn) { close(btn); btn.focus(); } }
  });
})();
