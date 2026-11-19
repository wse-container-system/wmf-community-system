"use strict";
/**
 * Race watch notification, run daily by .github/workflows/race-watch.yml. Needs nothing set up:
 * it reads the race pages itself and posts the new UAE cycling/triathlon races on one GitHub issue,
 * "Race watch: new UAE races", assigned to the repository owner. GitHub then notifies them by email and in its app.
 * The issue body remembers which races were already posted (hidden list at the end), so each race is posted once.
 *   GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name) and RACE_WATCH_ASSIGNEE come from the workflow.
 */
const S = require("../src/racesources");

const TITLE = "Race watch: new UAE races";
const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, assignee = process.env.RACE_WATCH_ASSIGNEE;
const api = async (path, opts = {}) => {
  const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "wmf-race-watch" } });
  if (!r.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d) => { const [y, m, dd] = d.split("-").map(Number); return `${dd} ${MON[m - 1]} ${y}`; };
const md = (s) => String(s).replace(/([\\[\]|*_`<>])/g, "\\$1");
const line = (r) => `- **${day(r.date)}${r.end && r.end !== r.date ? " – " + day(r.end) : ""}**: ${r.url ? `[${md(r.title)}](${r.url})` : md(r.title)}${r.location ? ` · ${md(r.location)}` : ""}`;
const SEEN_RE = /<!-- race-watch-seen:([a-f0-9,]*) -->/;

(async () => {
  const { races, errors } = await S.collect(S.DEFAULT_SOURCES);
  for (const e of errors) console.log(`! Could not read ${e.url}: ${e.error}`);
  console.log(`${races.length} upcoming UAE cycling/triathlon races listed.`);

  let issue = (await api("/issues?state=all&per_page=100&sort=created&direction=asc")).find((i) => !i.pull_request && i.title === TITLE);
  const seen = new Set(issue ? ((SEEN_RE.exec(issue.body || "") || [])[1] || "").split(",").filter(Boolean) : []);
  const fresh = races.filter((r) => !seen.has(r.key));
  console.log(`${fresh.length} new since the last check.`);
  fresh.forEach((r) => console.log("  " + line(r)));
  if (!fresh.length) return;

  const list = fresh.map(line).join("\n");
  const intro = "Every morning this checks the UAE race pages (RaceResult, Premier Online, Hopasports, Abu Dhabi Sports Council) " +
    "and posts the new **cycling, triathlon and duathlon** races here. The app adds them to the WMF calendar as *External race · Tentative*; " +
    "review them on Calendar → Race watch.\n\nKeep this issue open: new races arrive as comments, and GitHub notifies you by email and in its app.";
  for (const r of fresh) seen.add(r.key);
  const keep = [...seen].slice(-2000).join(","); // the hidden memory of races already posted
  const body = `${intro}\n\n<!-- race-watch-seen:${keep} -->`;
  if (!issue) {
    issue = await api("/issues", { method: "POST", body: JSON.stringify({ title: TITLE, body, assignees: assignee ? [assignee] : [] }) });
    console.log(`Created issue #${issue.number}`);
  } else {
    await api(`/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ body, state: "open" }) });
  }
  const mention = assignee ? `@${assignee} ` : "";
  await api(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: `${mention}${fresh.length} new race${fresh.length > 1 ? "s" : ""} found:\n\n${list}` }) });
  console.log(`Posted ${fresh.length} race(s) on issue #${issue.number}`);
})().catch((e) => { console.error(e); process.exit(1); });
