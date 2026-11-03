/* Self check-in: remember this phone's name and email so next week is one tap. Kept on the phone only. */
(function () {
  "use strict";
  var f = document.getElementById("checkin");
  if (!f) return;
  var K = "cd.checkin.me";
  var me = null;
  try { me = JSON.parse(localStorage.getItem(K) || "null"); } catch (e) { me = null; }
  if (me) {
    if (!f.full_name.value && me.full_name) f.full_name.value = me.full_name;
    if (!f.email.value && me.email) f.email.value = me.email;
  }
  f.addEventListener("submit", function () {
    try { localStorage.setItem(K, JSON.stringify({ full_name: f.full_name.value, email: f.email.value })); } catch (e) { /* storage blocked */ }
  });
})();
