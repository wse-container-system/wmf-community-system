/* Copy the newsletter so it can be pasted into Outlook (formatted) or Mailchimp (HTML code). */
(function () {
  "use strict";
  const html = document.getElementById("email-html").content.textContent || document.getElementById("email-html").textContent;
  const toast = document.getElementById("nToast");
  const say = (t) => { toast.textContent = t; setTimeout(() => { toast.textContent = ""; }, 4000); };
  async function copy(kind) {
    try {
      if (kind === "html" && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([document.getElementById("email-preview").innerText], { type: "text/plain" }) })]);
        return say("Copied. Paste it into a new Outlook email.");
      }
      await navigator.clipboard.writeText(html);
      say(kind === "html" ? "Copied as HTML code (your browser can't copy formatted email)." : "HTML code copied. Paste it into Mailchimp's “Code your own”.");
    } catch (e) {
      // fallback: select the preview so it can be copied with Ctrl/Cmd+C
      const r = document.createRange(); r.selectNodeContents(document.getElementById("email-preview"));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      say("Press Ctrl+C (or ⌘C) to copy the selected email.");
    }
  }
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copy(b.dataset.copy)));
})();
