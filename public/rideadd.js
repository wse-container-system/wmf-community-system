/* Add a ride: the new-ride name shows only for "+ New ride…", the number only for "Number of riders only". */
(function () {
  "use strict";
  var f = document.getElementById("rdAdd"); if (!f) return;
  var act = document.getElementById("rdAct"), nm = document.getElementById("rdNewName"), cnt = document.getElementById("rdCount");
  function draw() {
    nm.hidden = act.value !== "new";
    var m = f.querySelector("[name=mode]:checked");
    cnt.hidden = !m || m.value !== "count";
    cnt.querySelector("input").required = !cnt.hidden;
    nm.querySelector("input").required = !nm.hidden;
  }
  f.addEventListener("change", draw); draw();
})();
