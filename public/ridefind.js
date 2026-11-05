/* Attendance per ride: type a name, email, phone or Member ID and check the person in from the list. */
(function () {
  "use strict";
  var input = document.getElementById("rdFind"), list = document.getElementById("rdHits"), tpl = document.getElementById("rdBtn");
  if (!input || !list || !tpl) return;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var timer = null, last = "";
  input.addEventListener("input", function () {
    clearTimeout(timer);
    var q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ""; return; }
    timer = setTimeout(function () {
      last = q;
      fetch("/api/members/search?q=" + encodeURIComponent(q)).then(function (r) { return r.ok ? r.json() : []; }, function () { return []; }).then(function (rows) {
        if (q !== last) return;
        list.innerHTML = rows.length ? rows.slice(0, 8).map(function (m) {
          return "<li><span><b>" + esc(m.name) + '</b> <span class="muted">' + esc(m.memberId) + (m.hint ? " · " + esc(m.hint) : "") + "</span></span>" + tpl.innerHTML.replace(/__ID__/g, esc(m.memberId)) + "</li>";
        }).join("") : '<li class="muted">Nobody found. Try part of the name, the email or the phone number.</li>';
      });
    }, 250);
  });
})();
