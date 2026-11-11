"use strict";
// Social media: the cards and "see every metric" open the full insights.
(function () {
  const open = (e) => { const d = document.getElementById("social-full"); if (!d) return; if (e) e.preventDefault(); d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); };
  document.addEventListener("click", (e) => { if (e.target.closest("a[href]:not(.si-all)")) return; if (e.target.closest("[data-si-open], .si-all")) open(e); });
  document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("[data-si-open]")) open(e); });
})();
