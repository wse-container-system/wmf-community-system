/* Department "Add time": each activity shows its ready timings; picking the activity fills in the usual hours. */
(function () {
  "use strict";
  var box = document.getElementById("dsTimes"); if (!box) return;
  var form = box.closest("form"), chips = box.querySelector(".ds-chips"), fromTo = document.getElementById("dsFromTo");
  var from = form.querySelector("[name=start_time]"), to = form.querySelector("[name=end_time]");
  var T = {}; try { T = JSON.parse(box.getAttribute("data-times")); } catch (e) { /* no presets */ }
  function draw(act, fill) {
    var list = T[act] || [];
    var off = act === "Off";
    box.hidden = off || !list.length; fromTo.hidden = off;
    if (fill && list[0] && !off) { from.value = list[0][0]; to.value = list[0][1]; }
    chips.innerHTML = list.map(function (t) {
      var on = from.value === t[0] && to.value === t[1];
      return '<button type="button" class="ds-chip' + (on ? " on" : "") + '" data-f="' + t[0] + '" data-t="' + t[1] + '" aria-pressed="' + on + '">' + t[0] + "–" + t[1] + "</button>";
    }).join("");
  }
  var cur = form.querySelector("[name=activity]:checked");
  draw(cur ? cur.value : "Office", false);
  form.addEventListener("change", function (e) {
    if (e.target.name === "activity") draw(e.target.value, true);
    if (e.target.name === "start_time" || e.target.name === "end_time") { var c = form.querySelector("[name=activity]:checked"); draw(c ? c.value : "", false); }
  });
  chips.addEventListener("click", function (e) {
    var b = e.target.closest(".ds-chip"); if (!b) return;
    from.value = b.getAttribute("data-f"); to.value = b.getAttribute("data-t");
    var c = form.querySelector("[name=activity]:checked"); draw(c ? c.value : "", false);
  });
})();
