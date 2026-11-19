/* Event project board: drag a task to another column, the new-task panel, the progress slider and file pickers. */
(function () {
  "use strict";
  function toggleNew() {
    var p = document.getElementById("pjNew");
    if (!p) return;
    p.hidden = !p.hidden;
    if (!p.hidden) { p.scrollIntoView({ block: "nearest", behavior: "smooth" }); var i = p.querySelector("input[name=title]"); if (i) i.focus(); }
  }
  document.addEventListener("click", function (e) { if (e.target.closest("[data-pj-new]")) { e.preventDefault(); toggleNew(); } });
  document.addEventListener("keydown", function (e) {
    if (e.key === "n" && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.getElementById("pjNew")) { e.preventDefault(); toggleNew(); }
  });

  // ---- drag and drop between columns
  var board = document.querySelector("[data-pj-board]");
  if (board) {
    var base = board.getAttribute("data-pj-board"), dragged = null;
    board.addEventListener("dragstart", function (e) {
      var c = e.target.closest(".pj-card"); if (!c) return;
      dragged = c; c.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.getAttribute("data-id"));
    });
    board.addEventListener("dragend", function () {
      if (dragged) dragged.classList.remove("dragging");
      dragged = null; board.querySelectorAll(".pj-drop.over").forEach(function (d) { d.classList.remove("over"); });
    });
    board.addEventListener("dragover", function (e) {
      var d = e.target.closest(".pj-drop"); if (!d || !dragged) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      board.querySelectorAll(".pj-drop.over").forEach(function (x) { if (x !== d) x.classList.remove("over"); });
      d.classList.add("over");
    });
    board.addEventListener("dragleave", function (e) { var d = e.target.closest(".pj-drop"); if (d && !d.contains(e.relatedTarget)) d.classList.remove("over"); });
    board.addEventListener("drop", function (e) {
      var d = e.target.closest(".pj-drop"); if (!d || !dragged) return;
      e.preventDefault(); d.classList.remove("over");
      var col = d.closest(".pj-col"), status = col.getAttribute("data-status"), from = dragged.closest(".pj-col"), card = dragged;
      if (col === from) return;
      d.insertBefore(card, d.querySelector(".pj-empty"));
      card.classList.toggle("is-done", status === "done");
      var sel = card.querySelector(".pj-move select"); if (sel) sel.value = status;
      counts();
      fetch(base + "/t/" + card.getAttribute("data-id") + "/move", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ status: status }) })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (j) { ring(j.summary); })
        .catch(function () { from.querySelector(".pj-drop").insertBefore(card, from.querySelector(".pj-empty")); counts(); alertBox("The task couldn't be moved. Check your connection and try again."); });
    });
  }
  function counts() { document.querySelectorAll(".pj-col").forEach(function (c) { c.querySelector(".pj-col-head .pj-n").textContent = c.querySelectorAll(".pj-card").length; }); }
  function ring(s) {
    var r = document.querySelector(".pj-ring"); if (!r || !s) return;
    r.style.setProperty("--p", s.pct); r.querySelector("b").textContent = s.pct + "%";
    var l = document.querySelector(".pj-over-line b"); if (l) l.textContent = s.done + " of " + s.total;
    var st = document.querySelectorAll(".pj-stat b"); if (st.length === 3) { st[0].textContent = s.late; st[1].textContent = s.week; st[2].textContent = s.review; }
  }
  function alertBox(t) {
    var m = document.querySelector("main"), f = document.createElement("div");
    f.className = "flash err"; f.setAttribute("role", "alert"); f.textContent = t; m.insertBefore(f, m.firstChild);
  }

  // ---- task page: live progress value, unsaved title, chosen files
  var range = document.getElementById("pjRange");
  if (range) range.addEventListener("input", function () {
    var o = document.querySelector(".pj-out");
    if (o) o.textContent = range.value + "%"; range.style.setProperty("--v", range.value + "%");
  });
  document.querySelectorAll(".pj-titleform").forEach(function (f) { f.addEventListener("input", function () { f.classList.add("dirty"); }); });
  document.querySelectorAll(".pj-attach input").forEach(function (i) {
    i.addEventListener("change", function () {
      var p = i.closest(".pj-compose-bar").querySelector(".pj-picked");
      p.textContent = i.files.length ? (i.files.length === 1 ? i.files[0].name : i.files.length + " files") : "";
    });
  });
  document.querySelectorAll(".pj-dropzone").forEach(function (z) {
    ["dragenter", "dragover"].forEach(function (t) { z.addEventListener(t, function () { z.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (t) { z.addEventListener(t, function () { z.classList.remove("over"); }); });
  });
})();
