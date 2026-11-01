/* WMF calendar: which items fall on which days. Same file runs in the browser and on the server. */
(function (root) {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
  const iso = (d) => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  const add = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const diff = (a, b) => Math.round((parse(a) - parse(b)) / 864e5);
  const dow = (s) => parse(s).getUTCDay();
  const monday = (s) => add(s, -((dow(s) + 6) % 7));

  /** Does a repeating item fall on this date? r = {freq: weekly|custom|monthly, interval, weekdays[0-6], until, monthlyMode} */
  function hits(a, date) {
    const r = a.r;
    if (date < a.s) return false;
    if (r.until && date > r.until) return false;
    if (r.freq === "monthly") {
      if (r.monthlyMode === "dayOfMonth") return parse(date).getUTCDate() === parse(a.s).getUTCDate();
      return dow(date) === dow(a.s) && Math.ceil(parse(date).getUTCDate() / 7) === Math.ceil(parse(a.s).getUTCDate() / 7);
    }
    const days = r.weekdays && r.weekdays.length ? r.weekdays : [dow(a.s)];
    if (!days.includes(dow(date))) return false;
    const iv = Math.max(1, r.interval || 1);
    return iv === 1 || Math.round(diff(monday(date), monday(a.s)) / 7) % iv === 0;
  }
  const paused = (a, date) => a.r && a.r.pausedFrom && date >= a.r.pausedFrom && (!a.r.pausedUntil || date <= a.r.pausedUntil);

  /** Occurrences touching [from, to], grouped by day: {date: [{a, date, end, cancel}]} */
  function build(items, from, to) {
    const map = {};
    const put = (d, o) => (map[d] = map[d] || []).push(o);
    for (const a of items) {
      if (a.r) {
        for (let d = from < a.s ? a.s : from; d <= to; d = add(d, 1)) {
          if (hits(a, d) && !paused(a, d)) put(d, { a, date: d, end: d, cancel: a.status === "Cancelled" || !!(a.x && a.x[d] === "cancelled") });
        }
      } else {
        if (a.e < from || a.s > to) continue;
        const o = { a, date: a.s, end: a.e, cancel: a.status === "Cancelled" };
        for (let d = a.s < from ? from : a.s; d <= (a.e > to ? to : a.e); d = add(d, 1)) put(d, o);
      }
    }
    const rank = { track_closure: -1, wmf_event: 0, generic_event: 1, wmf_ride: 2 };
    for (const k in map) map[k].sort((x, y) => ((x.end > x.date ? 0 : 1) - (y.end > y.date ? 0 : 1)) || ((x.a.st || "99") < (y.a.st || "99") ? -1 : (x.a.st || "99") > (y.a.st || "99") ? 1 : 0) || rank[x.a.c] - rank[y.a.c]);
    return map;
  }
  const on = (items, date) => build(items, date, date)[date] || [];

  const api = { build, on, hits, add, diff, parse, iso, monday, dow };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WMFCalendar = api;
})(typeof self !== "undefined" ? self : this);
