/* New season survey: switching Summer / Winter fills in that season's usual activities and rides. */
(function () {
  "use strict";
  var sel = document.getElementById("ssSeason"); if (!sel) return;
  sel.addEventListener("change", function () {
    var k = sel.value === "Summer" ? "data-summer" : "data-winter";
    document.querySelectorAll("textarea[" + k + "]").forEach(function (t) { t.value = t.getAttribute(k); });
  });
})();
