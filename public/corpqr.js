/* Corporate: show a newly registered rider's QR code with buttons to send it (staff scanner and scanner links). */
/** Show a new rider's QR code with buttons to send it. Shared by the staff scanner and scanner links. */
window.corpQrKit = function (el, r) {
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var msg = "Hi " + r.first + ", welcome to the " + r.coName + " cycling programme! Here is your personal QR code: " + r.qrUrl + " \nPlease save it and show it to the ride lead at every session. Your ID is " + r.pid + ".";
  el.hidden = false;
  el.innerHTML = '<div class="qrbox" style="margin-top:10px"><img src="' + r.qr + '" alt="QR code for ' + esc(r.pid) + '"><span class="id">' + esc(r.pid) + '</span></div>'
    + '<p class="sc-note" style="text-align:center">' + (r.created ? "Added to the list and checked in. " : "Already on the list: checked in. ") + 'They can also take a photo of this screen.</p><div class="sc-send">'
    + '<a class="btn primary" href="https://wa.me/' + (r.phone ? encodeURIComponent(r.phone) : "") + '?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">Send on WhatsApp</a>'
    + (r.email ? '<a class="btn" href="mailto:' + encodeURIComponent(r.email) + '?subject=' + encodeURIComponent("Your personal QR code: " + r.coName + " cycling programme") + '&body=' + encodeURIComponent(msg) + '">Send by email</a>' : "")
    + '<button class="btn" type="button" data-copy="' + esc(r.qrUrl) + '">Copy link</button>'
    + '<a class="btn" href="' + r.qr + '" download="' + esc(r.pid) + '-QR.png">Download QR</a></div>';
  el.scrollIntoView({ behavior: "smooth", block: "center" });
};
