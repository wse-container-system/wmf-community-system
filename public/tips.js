/* Hover and focus tooltips for server-drawn charts: any element with data-tip="<b>value</b><br>label". */
(function () {
  "use strict";
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; tip.setAttribute("role", "status");
  document.body.appendChild(tip);
  const show = (t, x, y) => {
    tip.innerHTML = t.getAttribute("data-tip"); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x + 14)) + "px";
    tip.style.top = Math.max(8, y - h - 12) + "px";
  };
  document.addEventListener("pointerover", (e) => { const t = e.target.closest("[data-tip]"); if (t) show(t, e.clientX, e.clientY); });
  document.addEventListener("pointermove", (e) => { const t = e.target.closest("[data-tip]"); if (t && !tip.hidden) show(t, e.clientX, e.clientY); });
  document.addEventListener("pointerout", (e) => { if (e.target.closest("[data-tip]")) tip.hidden = true; });
  document.addEventListener("focusin", (e) => { const t = e.target.closest("[data-tip]"); if (t) { const r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top); } });
  document.addEventListener("focusout", () => { tip.hidden = true; });
})();
