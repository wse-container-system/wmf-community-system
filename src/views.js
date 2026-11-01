"use strict";
/** Small HTML helpers. Every value is escaped through h() unless it is already HTML built here. */
const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLE_TEXT = { admin: "Administrator", coordinator: "Coordinator", viewer: "Viewer", sponsor: "Sponsor" };

const NAV = [
  ["/", "Home", ["admin", "coordinator"]],
  ["/scan", "Scan QR", ["admin", "coordinator"]],
  ["/members", "Members", ["admin", "coordinator"]],
  ["/activities", "Rides & events", ["admin", "coordinator"]],
  ["/dashboard", "Dashboard", ["admin", "coordinator", "viewer", "sponsor"]],
  ["/admin", "Admin", ["admin"]],
];

function layout(title, body, { user, active, flash, scripts = "", wide = true } = {}) {
  const nav = user ? NAV.filter(([, , r]) => r.includes(user.role)).map(([href, label]) =>
    `<a href="${href}" ${active === href ? 'aria-current="page"' : ""}>${h(label)}</a>`).join("") : "";
  const fl = flash ? `<div class="flash ${h(flash.type || "info")}" role="status">${h(flash.text)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${h(title)} · WMF Community</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@87,500;87,600;87,700&family=Source+Sans+3:wght@400;600&display=swap">
<link rel="stylesheet" href="/app.css">
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <header class="top">
    <a class="brand" href="/" style="text-decoration:none;color:inherit">
      <div class="brand-mark" aria-hidden="true">WMF</div>
      <div><h1>${user ? "Community System" : "Women Moving Forward"}</h1><p class="sub">Women Moving Forward · UAE Team ADQ</p></div>
    </a>
    ${user ? `<nav class="shell-nav" aria-label="Main">${nav}
      <a href="/account/password" title="${h(user.email)}">${h(ROLE_TEXT[user.role])}</a>
      <form method="post" action="/logout"><button class="btn ghost">Sign out</button></form></nav>` : ""}
  </header>
  <main id="main" tabindex="-1" class="${wide ? "" : "narrow"}" style="display:grid;gap:14px">${fl}${body}</main>
  <footer class="foot"><span>WMF Community System</span><span>Times shown in UAE time</span></footer>
</div>
${scripts}
</body></html>`;
}

const fmtDate = (d) => {
  if (!d) return "—";
  const s = String(d);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+s.slice(8, 10)} ${M[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}${s.length > 10 && s.slice(11, 16) !== "00:00" ? ", " + s.slice(11, 16) : ""}`;
};
const fmtTs = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

module.exports = { h, layout, ROLE_TEXT, fmtDate, fmtTs };
