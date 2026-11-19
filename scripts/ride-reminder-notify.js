"use strict";
/**
 * Ride reminder backup, run by .github/workflows/ride-reminder.yml at 04:00 Dubai on ride days. Needs nothing set up:
 * it asks the app for today's ride message (/api/ride-reminder.json) and posts it on one GitHub issue,
 * "Ride reminder: WhatsApp message", assigned to the repository owner, so GitHub notifies them by email and in its app.
 * The comment has a link that opens WhatsApp with the message filled in.
 * When the app can't be reached, it builds the message itself from the usual schedule (Monday and Wednesday, 06:00, Hudayriyat Island).
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, RIDE_REMINDER_ASSIGNEE and APP_URL come from the workflow. FORCE=1 posts the next ride even on other days.
 */
const M = require("../src/ridemsg");

const TITLE = "Ride reminder: WhatsApp message";
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, assignee = process.env.RIDE_REMINDER_ASSIGNEE;
const APP = (process.env.APP_URL || "https://wmf-community.onrender.com").replace(/\/$/, "");
const force = process.env.FORCE === "1" || process.env.FORCE === "true";
const api = async (path, opts = {}) => {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "wmf-ride-reminder" } });
  if (!r.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Today's ride from the app (the free Render plan can take a minute to wake up). */
async function fromApp(date) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${APP}/api/ride-reminder.json${date ? "?date=" + date : ""}`, { signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
      console.log(`app: HTTP ${r.status}`);
    } catch (e) { console.log(`app: ${e.message}`); }
    await sleep(15000);
  }
  return null;
}

(async () => {
  const today = M.nowDubai().slice(0, 10);
  let x = await fromApp(force ? "" : today), note = "";
  if (!x) {
    note = "\n\n_The app didn't answer, so this uses the usual schedule (Monday and Wednesday, 6:00 AM, Hudayriyat Island)._";
    const ride = force ? M.nextRides(1)[0] : M.rideOn(today);
    if (ride) {
      const signupUrl = APP + M.signupPath(ride.date), weather = await M.weather(ride);
      const message = M.message(ride, { weather, signupUrl });
      x = { ride, weather, message, whatsapp: M.whatsappLink(message), signupUrl };
    } else x = { ride: null };
  }
  if (!x.ride) return console.log(`No ride on ${today}: nothing to post.`);
  if (x.skipped) return console.log(`The ${x.ride.day} ride on ${x.ride.date} is marked "No ride this day": nothing to post.`);
  console.log(x.message);

  let issue = (await api("/issues?state=all&per_page=100&sort=created&direction=asc")).find((i) => !i.pull_request && i.title === TITLE);
  if (!issue) {
    const body = "On ride days (Monday and Wednesday) at 4 AM Dubai time, the WhatsApp message for the WMF group is posted here, so GitHub " +
      "notifies you by email and in its app. Tap **Open WhatsApp with the message**, pick the WMF group and send.\n\n" +
      "The app shows the same message on the Hub and WMF home (from 6 PM the evening before), and on WMF → WhatsApp ride reminder, " +
      "where you can change the ride days, time and meeting point.\n\nKeep this issue open.";
    issue = await api("/issues", { method: "POST", body: JSON.stringify({ title: TITLE, body, assignees: assignee ? [assignee] : [] }) });
    console.log(`Created issue #${issue.number}`);
  } else if (issue.state !== "open") {
    await api(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) });
  }
  const mention = assignee ? `@${assignee} ` : "";
  const body = `${mention}The **${x.ride.day} ride** message is ready (${M.longDate(x.ride.date)}, ${M.time12(x.ride.time)}, ${x.ride.location}).\n\n` +
    `### [📲 Open WhatsApp with the message](${x.whatsapp})\n\nOr copy it:\n\n\`\`\`\n${x.message}\n\`\`\`` +
    (x.signups != null ? `\n\n${x.signups} signed up so far.` : "") + note;
  await api(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  console.log(`Posted on issue #${issue.number}`);
})().catch((e) => { console.error(e); process.exit(1); });
