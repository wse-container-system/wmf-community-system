"use strict";
/**
 * Email sending. Optional: set SMTP_HOST, SMTP_USER and SMTP_PASS (and SMTP_PORT, MAIL_FROM if needed) on Render.
 * Without them the app opens a ready-written email in your own mail app instead.
 */
let transport = null;
const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
function get() {
  if (!configured()) return null;
  if (!transport) {
    const port = +process.env.SMTP_PORT || 587;
    transport = require("nodemailer").createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  }
  return transport;
}
/** Send one email. Returns true when sent. */
async function send({ to, subject, text, html, attachments }) {
  const t = get(); if (!t) return false;
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html, attachments });
  return true;
}
module.exports = { configured, send };
