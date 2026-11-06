"use strict";
// Marketing form: show the name / date / people fields only for "Other event or activity".
(function () {
  for (const sel of document.querySelectorAll("[data-mk-target]")) {
    const box = sel.form.querySelector(".mk-other");
    const sync = () => { const on = sel.value === "o"; box.hidden = !on; const n = box.querySelector("[name=other_event]"); if (n) n.required = on; if (on && n && !n.value) n.focus(); };
    sel.addEventListener("change", sync); sync();
  }
})();
