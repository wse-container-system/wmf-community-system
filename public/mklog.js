"use strict";
// Marketing form: "Other event" shows its name / date / people fields; a WMF event shows its strategy box, filled with what's saved.
(function () {
  for (const sel of document.querySelectorAll("[data-mk-target]")) {
    const box = sel.form.querySelector(".mk-other"), strat = sel.form.querySelector(".mk-strat-f");
    const ta = strat && strat.querySelector("textarea");
    let first = true;
    const sync = () => {
      const v = sel.value, on = v === "o"; box.hidden = !on;
      const n = box.querySelector("[name=other_event]"); if (n) n.required = on;
      if (on && n && !n.value && !first) n.focus();
      if (strat) {
        const ev = /^(a|e):/.test(v); strat.hidden = !ev; ta.disabled = !ev;
        if (ev && !first) ta.value = sel.selectedOptions[0].getAttribute("data-s") || "";
      }
      first = false;
    };
    sel.addEventListener("change", sync); sync();
  }
})();
