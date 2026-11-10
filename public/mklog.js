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

// Posts by channel: add / remove channels, types and metrics; on save, each row carries its channel and metrics.
(function () {
  for (const form of document.querySelectorAll("[data-mk-form]")) {
    const tpl = (k) => form.querySelector(`template[data-mk-tpl="${k}"]`).content.firstElementChild.cloneNode(true);
    const chs = form.querySelector("[data-mk-chs]");
    form.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || !form.contains(b)) return;
      if (b.hasAttribute("data-mk-addch")) { const c = tpl("ch"); chs.appendChild(c); c.querySelector(".mk-chname").focus(); }
      else if (b.hasAttribute("data-mk-delch")) { if (chs.children.length > 1) b.closest(".mk-ch").remove(); else b.closest(".mk-ch").querySelectorAll("input:not([type=hidden])").forEach((i) => { if (i.name !== "r_date" && i.name !== "r_kind") i.value = ""; }); }
      else if (b.hasAttribute("data-mk-addrow")) { const r = tpl("row"); b.closest(".mk-ch").querySelector(".mk-rows").appendChild(r); r.querySelector("[name=r_kind]").select(); }
      else if (b.hasAttribute("data-mk-delrow")) { const rows = b.closest(".mk-rows"); if (rows.children.length > 1) b.closest(".mk-row").remove(); }
      else if (b.hasAttribute("data-mk-addmet")) { const m = tpl("met"); b.before(m); m.querySelector(".mk-mn").focus(); }
      else if (b.hasAttribute("data-mk-delmet")) b.closest(".mk-met").remove();
      else return;
      e.preventDefault();
    });
    form.addEventListener("submit", () => {
      for (const ch of form.querySelectorAll("[data-mk-chs] .mk-ch")) {
        const name = ch.querySelector(".mk-chname").value.trim();
        for (const row of ch.querySelectorAll(".mk-row")) {
          row.querySelector("[name=r_channel]").value = name;
          row.querySelector("[name=r_metrics]").value = [...row.querySelectorAll(".mk-met")]
            .map((m) => [m.querySelector(".mk-mn").value.trim().replace(/[|=]/g, " "), m.querySelector(".mk-mv").value.trim()])
            .filter(([n, v]) => n && v).map(([n, v]) => `${n}=${v}`).join("|");
        }
      }
    });
  }
})();
