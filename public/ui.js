/* Small page behaviours used across the hub (the security policy allows no inline scripts). */
(function () {
  "use strict";
  document.addEventListener("click", function (e) {
    var p = e.target.closest("[data-print]");
    if (p) { e.preventDefault(); window.print(); return; }
    var all = e.target.closest("[data-check-all]");
    if (all) {
      e.preventDefault();
      var box = document.querySelector(all.getAttribute("data-check-all"));
      if (!box) return;
      var inputs = box.querySelectorAll("input[type=checkbox]");
      var on = Array.prototype.some.call(inputs, function (i) { return !i.checked; });
      inputs.forEach(function (i) { i.checked = on; });
      return;
    }
    var cp = e.target.closest("[data-copy]");
    if (cp) {
      e.preventDefault();
      var text = cp.getAttribute("data-copy"), old = cp.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { cp.textContent = "Copied"; }, function () { window.prompt("Copy this link", text); })
        .finally(function () { setTimeout(function () { cp.textContent = old; }, 2500); });
    }
  });
  // forms that ask before doing something hard to undo
  document.addEventListener("submit", function (e) {
    var msg = e.target.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  // filters that apply as soon as they change
  document.addEventListener("change", function (e) {
    if (e.target.matches("[data-autosubmit]")) e.target.form.submit();
  });
})();
