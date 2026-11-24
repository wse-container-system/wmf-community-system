/* Department "Add time": each activity shows its ready timings; picking the activity fills in the usual hours.
   "Annual leave" swaps the times for a date range, the leave type and confirmed / tentative. */
(function () {
  "use strict";
  var box = document.getElementById("dsTimes"); if (!box) return;
  var form = box.closest("form"), chips = box.querySelector(".ds-chips"), fromTo = document.getElementById("dsFromTo");
  var from = form.querySelector("[name=start_time]"), to = form.querySelector("[name=end_time]");
  var shifts = document.getElementById("dsShifts"), leave = document.getElementById("dsLeave"), leaveTo = document.getElementById("dsLeaveTo");
  var note = document.getElementById("dsNote"), rep = document.getElementById("dsRepeat"), dateLbl = document.getElementById("dsDateLbl");
  var T = {}; try { T = JSON.parse(box.getAttribute("data-times")); } catch (e) { /* no presets */ }
  function t12(t) { var p = t.split(":"), hh = +p[0]; return (hh % 12 || 12) + ":" + p[1] + (hh >= 12 ? " PM" : " AM"); }
  function show(el, on) { if (el) el.hidden = !on; }
  function draw(act, fill) {
    var list = T[act] || [];
    var isLeave = act === "Leave", off = act === "Off" || isLeave;
    box.hidden = off || !list.length; fromTo.hidden = off;
    from.required = to.required = !off;
    show(shifts, act === "Office"); show(leave, isLeave); show(leaveTo, isLeave); show(note, !isLeave); show(rep, !isLeave);
    if (dateLbl) dateLbl.textContent = isLeave ? "From" : "Date";
    var hint = document.getElementById("dsTimesHint"); if (hint) hint.textContent = act === "Office" ? "Office shifts: tap one" : "Ready times: tap one";
    if (fill && list[0] && !off) { from.value = list[0][0]; to.value = list[0][1]; }
    chips.innerHTML = list.map(function (t) {
      var on = from.value === t[0] && to.value === t[1];
      return '<button type="button" class="ds-chip' + (on ? " on" : "") + '" data-f="' + t[0] + '" data-t="' + t[1] + '" aria-pressed="' + on + '">' + t12(t[0]) + " – " + t12(t[1]) + "</button>";
    }).join("");
    if (shifts) Array.prototype.forEach.call(shifts.querySelectorAll(".ds-shift"), function (b) {
      var on = from.value === b.getAttribute("data-f") && to.value === b.getAttribute("data-t");
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    });
  }
  var cur = form.querySelector("[name=activity]:checked");
  draw(cur ? cur.value : "Office", false);
  form.addEventListener("change", function (e) {
    if (e.target.name === "activity") draw(e.target.value, true);
    if (e.target.name === "start_time" || e.target.name === "end_time") { var c = form.querySelector("[name=activity]:checked"); draw(c ? c.value : "", false); }
    if (e.target.name === "work_date" && leaveTo) { var lt = leaveTo.querySelector("input"); if (lt && (!lt.value || lt.value < e.target.value)) lt.value = e.target.value; }
  });
  form.addEventListener("click", function (e) {
    var b = e.target.closest(".ds-chip, .ds-shift"); if (!b) return;
    from.value = b.getAttribute("data-f"); to.value = b.getAttribute("data-t");
    var c = form.querySelector("[name=activity]:checked"); draw(c ? c.value : "", false);
  });
})();
