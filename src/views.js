"use strict";
/** Small HTML helpers. Every value is escaped through h() unless it is already HTML built here. */
const h = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLE_TEXT = { admin: "Administrator", coordinator: "Coordinator", viewer: "Viewer", sponsor: "Sponsor" };
const STAFF = ["admin", "coordinator"], ALL = ["admin", "coordinator", "viewer", "sponsor"];

/**
 * The Cycling Development hub has three areas. Each has its own sub-menu.
 * A user limited to one corporate partner (users.company) only sees the Corporate reports.
 */
const SECTIONS = [
  { key: "wmf", label: "WMF", home: "/wmf", roles: ALL, scoped: false, match: /^\/(wmf|overview|scan|members|activities|activations|partners|rides|newsletter|calendar|dashboard|surveys|social|report|dubai)(\/|$)/, links: [
    ["/wmf", "Home", STAFF], ["/overview", "Overview", ALL], ["/wmf/rides", "Rides", ["admin", "coordinator", "viewer"]], ["/members", "Members", STAFF], ["/activities", "Events", STAFF],
    ["/activations", "Activations", ["admin", "coordinator", "viewer"]], ["/surveys", "Surveys", STAFF], ["/social", "Social growth", STAFF], ["/calendar", "Calendar", ALL],
    ["/report", "Reports", ["admin", "coordinator", "viewer"]], ["/newsletter", "Newsletter", STAFF], ["/dashboard", "Dashboard", ALL]] },
  { key: "corporate", label: "Corporate", home: "/corporate", roles: ALL, scoped: true, match: /^\/corporate(\/|$)/, links: [
    ["/corporate", "Dashboard", ALL], ["/corporate/attendance", "Attendance", STAFF], ["/corporate/schedule", "Schedule", STAFF], ["/corporate/events", "Events", STAFF],
    ["/corporate/participants", "Participants", STAFF], ["/corporate/qr", "QR codes", STAFF], ["/corporate/scan", "Scan", STAFF], ["/corporate/report", "Reports", ALL]] },
  { key: "department", label: "Department", home: "/department/schedule", roles: STAFF, scoped: false, match: /^\/department(\/|$)/, links: [
    ["/department/schedule", "Schedule", STAFF], ["/department/leave", "Leave", STAFF], ["/department/staff", "Team", ["admin"]], ["/department/share", "Share", ["admin"]]] },
];
const sectionsFor = (u) => SECTIONS.filter((s) => s.roles.includes(u.role) && (!u.company || s.scoped));

function sectionOf(path) {
  const s = SECTIONS.find((x) => x.match.test(path || ""));
  return s ? s.key : path && path.startsWith("/admin") ? "admin" : "hub";
}

function layout(title, body, { user, active, flash, scripts = "", wide = true } = {}) {
  const sec = sectionOf(active);
  const secs = user ? sectionsFor(user) : [];
  const top = user ? [`<a href="/" ${sec === "hub" ? 'aria-current="page"' : ""}>Hub</a>`,
    ...secs.map((s) => `<a href="${s.home}" ${sec === s.key ? 'aria-current="page"' : ""}>${h(s.label)}</a>`),
    user.role === "admin" ? `<a href="/admin" ${sec === "admin" ? 'aria-current="page"' : ""}>Admin</a>` : ""].join("") : "";
  const cur = SECTIONS.find((s) => s.key === sec);
  const sub = user && cur && secs.includes(cur) ? cur.links.filter(([, , r]) => r.includes(user.role)) : [];
  const subNav = sub.length > 1 ? `<nav class="sub-nav" aria-label="${h(cur.label)}">${sub.map(([href, label]) =>
    `<a href="${href}" ${active === href ? 'aria-current="page"' : ""}>${h(label)}</a>`).join("")}</nav>` : "";
  const isWmf = sec === "wmf";
  const brand = isWmf
    ? `<picture class="brand-logo"><source srcset="/brand/wmf-logo-dark.png" media="(prefers-color-scheme: dark)"><img src="/brand/wmf-logo.png" alt="WMN Moving FWD, powered by Aurora" width="640" height="142"></picture>
       ${user ? `<div class="brand-name"><h1>Community System</h1></div>` : ""}`
    : `<span class="cd-mark" aria-hidden="true"><svg viewBox="0 0 40 40" width="40" height="40"><circle cx="11" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="29" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11 26 L18 13 L26 13 M18 13 L23 26 L29 26 M24 9 h5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
       <div class="brand-name"><h1>Cycling Development</h1><p class="sub">${h(cur ? cur.label === "WMF" ? "WMN Moving FWD" : cur.label === "Corporate" ? "Corporate Cycling Programme" : "Department admin" : sec === "admin" ? "Administration" : "Department hub")}</p></div>`;
  const fl = flash ? `<div class="flash ${h(flash.type || "info")}" role="status">${h(flash.text)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${h(title)} · ${isWmf ? "WMN Moving FWD" : "Cycling Development"}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@87,500;87,600;87,700&family=Source+Sans+3:wght@400;600&display=swap">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/hub.css">
<link rel="icon" type="image/png" href="/brand/favicon.png"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"><meta name="theme-color" content="#979fe7">
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <header class="top">
    <a class="brand" href="/" style="text-decoration:none;color:inherit">${brand}</a>
    ${user ? `<nav class="shell-nav" aria-label="Main">${top}
      <a href="/account/password" title="${h(user.email)}">${h(ROLE_TEXT[user.role])}${user.company ? " · " + h(user.company) : ""}</a>
      <form method="post" action="/logout"><button class="btn ghost">Sign out</button></form></nav>` : ""}
  </header>
  ${subNav}
  <main id="main" tabindex="-1" class="${wide ? "" : "narrow"}" style="display:grid;gap:14px">${fl}${body}</main>
  <footer class="foot"><span>Cycling Development · WMN Moving FWD · Corporate Cycling · Powered by Aurora</span><span>Times shown in UAE time</span></footer>
</div>
<script src="/ui.js"></script>
${scripts}
</body></html>`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d) => {
  if (!d) return "—";
  const s = String(d);
  return `${+s.slice(8, 10)} ${MON[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}${s.length > 10 && s.slice(11, 16) !== "00:00" ? ", " + s.slice(11, 16) : ""}`;
};
const fmtTs = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const monLabel = (m, long) => long
  ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][+m.slice(5, 7) - 1] + " " + m.slice(0, 4)
  : MON[+m.slice(5, 7) - 1] + " ’" + m.slice(2, 4);
const nf = (n, d = 0) => (n == null || Number.isNaN(+n) ? "—" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
const tile = (label, val, note, href) => `<${href ? `a href="${href}"` : "div"} class="tile"${href ? ' style="text-decoration:none;color:inherit"' : ""}><span class="lbl">${h(label)}</span><span class="val">${h(val)}</span>${note ? `<span class="note">${h(note)}</span>` : ""}</${href ? "a" : "div"}>`;
const table = (heads, rows, { num = [], empty = "Nothing to show yet." } = {}) => `<div class="tw"><table><thead><tr>${heads.map((x, i) => `<th${num.includes(i) ? ' class="n"' : ""}>${h(x)}</th>`).join("")}</tr></thead><tbody>
  ${rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td${num.includes(i) ? ' class="n"' : ""}>${c && c.html != null ? c.html : h(c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}" class="muted">${h(empty)}</td></tr>`}</tbody></table></div>`;
const raw = (html) => ({ html });

module.exports = { h, layout, ROLE_TEXT, fmtDate, fmtTs, monLabel, nf, tile, table, raw, SECTIONS, sectionsFor, STAFF, ALL };
