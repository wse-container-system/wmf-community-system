/* Ride report page for a city lead: special-ride name, other date, +/- riders, and photos made smaller on the phone before sending. */
(function () {
  "use strict";
  var form = document.getElementById("lrForm"); if (!form) return;
  var $ = function (s) { return form.querySelector(s); };
  var title = document.getElementById("lrTitle"), date = document.getElementById("lrDate"), count = $("input[name=participants]");
  form.addEventListener("change", function (e) {
    if (e.target.name === "ride_type") { title.hidden = e.target.value !== "Special ride"; if (!title.hidden) title.querySelector("input").focus(); }
    if (e.target.name === "day") { date.hidden = e.target.value !== "other"; if (!date.hidden) date.focus(); }
  });
  form.querySelectorAll("[data-step]").forEach(function (b) {
    b.addEventListener("click", function () { var v = Math.max(0, Math.min(500, (parseInt(count.value, 10) || 0) + parseInt(b.getAttribute("data-step"), 10))); count.value = v; });
  });

  // photos: shrink to about 1600 px so they upload quickly on a phone signal
  var input = document.getElementById("lrPhotos"), prev = document.getElementById("lrPreview"), msg = document.getElementById("lrMsg"), btn = document.getElementById("lrSend");
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || file.size < 400000) return resolve(file);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file); }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  if (input) input.addEventListener("change", function () {
    prev.innerHTML = "";
    Array.prototype.slice.call(input.files, 0, 6).forEach(function (f) { var i = document.createElement("img"); i.alt = ""; i.src = URL.createObjectURL(f); prev.appendChild(i); });
    if (input.files.length > 6) msg.textContent = "Only the first 6 photos will be sent.";
  });
  form.addEventListener("submit", function (e) {
    if (!window.fetch || !window.FormData) return; // the plain form still works
    e.preventDefault();
    if (!form.reportValidity()) return;
    btn.disabled = true; msg.textContent = input && input.files.length ? "Sending photos…" : "Sending…";
    var fd = new FormData(form); fd.delete("photos");
    Promise.all(Array.prototype.slice.call(input ? input.files : [], 0, 6).map(shrink)).then(function (files) {
      files.forEach(function (f) { fd.append("photos", f, f.name); });
      return fetch(location.pathname, { method: "POST", body: fd });
    }).then(function (r) {
      if (r.redirected || r.ok && /\?ok=/.test(r.url)) { location.href = r.url; return; }
      return r.text().then(function (t) { document.open(); document.write(t); document.close(); });
    }, function () { msg.textContent = "No connection. Check the signal and tap Send again."; btn.disabled = false; });
  });
})();
