/* Plain-language camera help for the scanners: why the camera didn't start, and a warning inside WhatsApp/Instagram-type browsers. */
(function () {
  "use strict";
  var ua = navigator.userAgent || "";
  var inApp = /WhatsApp|FBAN|FBAV|Instagram|Line\/|Snapchat|; wv\)|LinkedInApp|GSA\//i.test(ua);
  var ios = /iPhone|iPad|iPod/i.test(ua);
  window.cameraHelp = function (err) {
    var e = String((err && (err.name || err.message)) || err || "");
    if (!window.isSecureContext) return "The camera only works on the secure (https://) address. Open the link that starts with https://.";
    if (inApp) return "This page is open inside another app (like WhatsApp), which blocks the camera. Tap ⋯ or the share icon and choose “Open in " + (ios ? "Safari" : "Chrome") + "”, then try again. Or use “Take a photo of the code”.";
    if (/NotAllowed|Permission|denied/i.test(e)) return ios
      ? "Camera permission is blocked for this site. In Safari tap “aA” in the address bar › Website Settings › Camera › Allow (or Settings › Safari › Camera › Allow), then reload."
      : "Camera permission is blocked for this site. Tap the lock or settings icon next to the address › Permissions › Camera › Allow, then reload.";
    if (/NotReadable|TrackStart|Could not start|in use/i.test(e)) return "The camera is being used by another app (camera, WhatsApp call, Zoom…). Close it and tap Start again.";
    if (/NotFound|DevicesNotFound|Requested device not found/i.test(e)) return "No camera was found on this device. Use a phone, or type the ID below.";
    if (/NotSupported|not supported/i.test(e)) return "This browser can't use the camera. Open the link in " + (ios ? "Safari" : "Chrome") + ", or use “Take a photo of the code”.";
    if (/Overconstrained/i.test(e)) return "This phone's camera didn't accept the settings. Tap Start again.";
    return "The camera didn't start (" + e.slice(0, 80) + "). Reload the page and tap Start again, or type the ID below.";
  };
  if (inApp) document.addEventListener("DOMContentLoaded", function () {
    var m = document.querySelector("main"); if (!m) return;
    var d = document.createElement("div");
    d.className = "alert warn"; d.setAttribute("role", "alert");
    d.innerHTML = '<span class="ic">!</span><span><b>Open this page in ' + (ios ? "Safari" : "Chrome") + ' for the camera to work.</b> Apps like WhatsApp open links in their own browser, which blocks the camera. Tap ⋯ / the share icon › “Open in ' + (ios ? "Safari" : "Chrome") + '”.</span>';
    m.insertBefore(d, m.firstChild);
  });
})();
