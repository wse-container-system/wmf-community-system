/* WMF KPI engine — read-only calculations.
 * Plain JavaScript with no dependencies, so the same logic can later run inside the
 * read-only Office Script (TypeScript) that builds the SharePoint snapshots.
 * Rules agreed with Rona, 30 Sep – 1 Oct 2026 (see the architecture plan, section 9).
 */
(function (root) {
  "use strict";

  const RULES = {
    activeWindowDays: 90,      // active = 2+ qualifying participations in the 90 days ending TODAY
    activeMin: 2,
    lapseDays: 60,             // follow-up: previously active, nothing for 60+ days …
    lapseLookbackDays: 180,    // … but something in the last 180 days
    newNoReturnDays: 30,       // follow-up: one participation only, 30–90 days ago
    smallCount: 5,             // sponsor view shows counts below 5 as "<5"
  };
  const FORM_SOURCES = ["WMF Attendance Form", "WMF Event Registration Form", "WMF One-Time Registration Form"];
  const APPROVED_COMMUNITY = []; // no approved list yet: every value is reported as-is

  // ---------- small date helpers (ISO strings, UTC arithmetic) ----------
  const day = (iso) => (iso || "").slice(0, 10);
  const month = (iso) => (iso || "").slice(0, 7);
  const toMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDays = (d, n) => fromMs(toMs(d) + n * 864e5);
  const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / 864e5);
  const addMonths = (m, n) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + n; const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12; return `${yy}-${String(mm + 1).padStart(2, "0")}`; };
  const monthEnd = (m) => addDays(addMonths(m, 1) + "-01", -1);
  const quarterOf = (d) => `${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
  const monthsBetween = (a, b) => { const out = []; for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m); return out; };

  // ---------- normalisation ----------
  const clean = (s) => (s == null ? "" : String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim());
  const norm = (s) => clean(s).toLowerCase();
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
  const TYPO_RE = /@(homtail|hotmial|gmial|gamil|gmai|yaho|exmaple)\.|\.con$/i;
  const goodKey = (k) => /^[ep]\|.+/.test(k);

  /** Ride series, event name and location for one activity row (agreed 1 Oct). */
  function classify(r) {
    const name = norm(r.activityName), id = norm(r.activityId), type = norm(r.activityType);
    if (r.recordType === "Member Registration") return { kind: "registration", series: "Member registration", activity: "Member registration" };
    if (r.recordType === "Event Registration") return { kind: "event", series: null, activity: clean(r.activityName) };
    if (name === "workshop") return { kind: "event", series: null, activity: "Summer Workshop" };   // moved to events, 1 Oct
    if (type.includes("ride") || r.recordType === "Attendance") {
      const s = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].find((w) => name.includes(w) || id.includes(w));
      // no weekday in the name (Morning Ride, Weekend Long Ride, Mountain Ride): use the weekday of the ride date, as for the history
      const wd = s || (r.date ? ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(String(r.date).slice(0, 10) + "T12:00:00Z").getUTCDay()] : null);
      const series = wd ? wd[0].toUpperCase() + wd.slice(1) + " Ride" : "Other ride";
      return { kind: "ride", series, activity: series };
    }
    return { kind: "other", series: null, activity: clean(r.activityName) };
  }
  /** Abu Dhabi unless the name, ID or Activity Setup says Dubai (agreed 1 Oct). */
  function locationOf(r, setupLocations) {
    const fromSetup = setupLocations && setupLocations[clean(r.activityId)];
    if (fromSetup) return fromSetup;
    const t = norm(r.activityName) + " " + norm(r.activityId);
    return /\bdubai\b|\bdxb\b/.test(t) ? "Dubai" : "Abu Dhabi";
  }

  // ---------- identity: one person per Member ID, key or email (union-find) ----------
  function makeUF() {
    const p = new Map();
    const find = (x) => { if (!p.has(x)) p.set(x, x); while (p.get(x) !== x) { p.set(x, p.get(p.get(x))); x = p.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p.set(ra, rb); };
    return { find, union };
  }

  /** Prepare raw snapshot data once: identity, classification, exclusions, data-quality checks. */
  function prepare(data, opts) {
    opts = opts || {};
    const cfg = { excludeEmails: [], separateEvents: [], ...(data.config || {}), ...(opts.config || {}) };
    const testEmails = new Set(cfg.excludeEmails.map(norm));
    const separate = new Set(cfg.separateEvents.map(norm));
    const uf = makeUF();
    const isTest = (email, key) => testEmails.has(norm(email)) || testEmails.has(norm(key).replace(/^e\|/, ""));
    const members = data.members.filter((m) => !isTest(m.email, m.memberKey)).map((m, i) => ({ ...m, _i: i, key: norm(m.memberKey), emailN: norm(m.email) }));
    for (const m of members) {
      const id = "id:" + m.memberId; uf.find(id);
      if (goodKey(m.key) || m.key.startsWith("n|")) uf.union("k:" + m.key, id);   // the member list also uses name-only keys for 65 people without email
      if (m.emailN) uf.union("e:" + m.emailN, id);
      for (const alt of String(m.altEmails || "").split(/[;,\s]+/)) if (norm(alt).includes("@")) uf.union("e:" + norm(alt), id);  // alternative emails, same person
    }
    const rows = data.activity.map((r, i) => {
      const key = norm(r.memberKey), email = norm(r.email);
      const nodes = [];
      if (goodKey(key)) nodes.push("k:" + key);
      if (email) nodes.push("e:" + email);
      if (r.source === "WMF QR Attendance Scanner" && /^WMF-\d+$/.test(clean(r.formResponseId))) nodes.push("id:" + clean(r.formResponseId));
      if (!nodes.length && key.startsWith("n|")) nodes.push("k:" + key);
      for (let j = 1; j < nodes.length; j++) uf.union(nodes[j], nodes[0]);
      const c = classify(r);
      return { ...r, _i: i, _node: nodes[0] || null, keyN: key, emailN: email, d: day(r.date), m: month(r.date),
               kind: c.kind, series: c.series, activity: c.activity, location: locationOf(r, opts.setupLocations || data.setupLocations), excluded: null };
    });
    const memberOfRoot = new Map();
    for (const m of members) { m.person = uf.find("id:" + m.memberId); memberOfRoot.set(m.person, m); }
    for (const r of rows) { r.person = r._node ? uf.find(r._node) : null; r.member = r.person ? memberOfRoot.get(r.person) || null : null; }

    // --- exclusions, in a fixed order ---
    for (const r of rows) if (isTest(r.email, r.memberKey)) r.excluded = "Test entry (removed on request)";   // 0. test rows
    for (const r of rows) r.separate = r.kind === "event" && separate.has(norm(r.activity));          // large events reported on their own
    const seen = new Map();
    for (const r of rows) {                                   // 1. repeated copies of one form response
      if (r.excluded || !FORM_SOURCES.includes(r.source) || !clean(r.formResponseId)) continue;
      const k = [r.source, clean(r.formResponseId), r.person || r.keyN || r.emailN].join("|");
      if (seen.has(k)) r.excluded = "Repeated copy of the same form response"; else seen.set(k, r);
    }
    const qual = (r) => !r.excluded && ((r.kind === "ride" && r.status === "Attended") || r.kind === "event");
    const seenP = new Set();
    for (const r of rows) {                                   // 2. same person, same activity, same day (events: same event)
      if (!qual(r) || !r.person) continue;
      const k = r.kind === "event" ? `${r.person}|event|${norm(r.activity)}` : `${r.person}|${r.d}|${r.series}`;
      if (seenP.has(k)) r.excluded = "Same person counted twice for the same activity"; else seenP.add(k);
    }
    for (const r of rows) r.qualifying = qual(r);

    // --- per-person participation history (all time, qualifying, de-duplicated) ---
    const persons = new Map();
    for (const r of rows) {
      if (!r.qualifying || !r.person) continue;
      if (!persons.has(r.person)) persons.set(r.person, { person: r.person, member: r.member, dates: [], rideDates: [], label: null });
      persons.get(r.person).dates.push(r.d);
      if (r.kind === "ride") persons.get(r.person).rideDates.push(r.d);
    }
    for (const p of persons.values()) {
      p.dates.sort(); p.first = p.dates[0]; p.last = p.dates[p.dates.length - 1];
      p.label = p.member ? p.member.label : "Not in member list";
      p.rideDates.sort(); p.firstRide = p.rideDates[0] || null; p.lastRide = p.rideDates[p.rideDates.length - 1] || null;
      p.everActive = p.rideDates.length > 0;   // under the 1 Oct rule every rider is active for at least 90 days after a first ride
    }

    const historyRides = (data.historyRides || []).map((h) => ({ ...h, d: day(h.date), m: month(h.date) }));
    const historyEvents = (data.historyEvents || []).map((h) => ({ ...h, d: day(h.month), m: month(h.month), separate: separate.has(norm(h.name)) }));
    const historyEnd = historyRides.reduce((a, h) => (h.d > a ? h.d : a), "");
    const historyDays = new Set(historyRides.map((h) => h.d));
    for (const r of rows) r.coveredByHistory = r.kind === "ride" && r.d <= historyEnd && historyDays.has(r.d);

    const P = { meta: data.meta || {}, config: cfg, members, rows, persons, historyRides, historyEvents, historyEnd, rules: RULES,
      removedTestMembers: data.members.length - members.length };
    P.quality = qualityChecks(P);
    const flagged = new Set();
    for (const c of P.quality.checks) for (const x of c.items) flagged.add(x.table + ":" + x.index);
    P.quality.flaggedRecords = flagged.size;
    const allDays = rows.map((r) => r.d).concat(historyRides.map((h) => h.d), members.map((m) => day(m.firstSeen))).filter(Boolean).sort();
    const fallback = (P.meta.asOf || new Date().toISOString()).slice(0, 10);   // empty workbook: nothing to show, but no crash
    P.dataStart = allDays[0] || fallback; P.dataEnd = allDays[allDays.length - 1] || fallback;
    return P;
  }

  // ---------- data-quality checks (proposals only — nothing is changed) ----------
  function qualityChecks(P) {
    const checks = [];
    const add = (id, label, severity, why, items) => checks.push({ id, label, severity, why, count: items.length, items });
    const mItem = (m, field, current, proposed) => ({ table: "WMFMemberMaster", index: m._i, ref: m.memberId, label: m.label, field, current, proposed });
    const rItem = (r, field, current, proposed) => ({ table: "WMFActivityDatabase", index: r._i, ref: r.recordId || "(no ID)", label: r.member ? r.member.label : "—", date: r.d, field, current, proposed });
    const M = P.members, R = P.rows;

    const byEmail = groupBy(M.filter((m) => m.emailN), (m) => m.emailN);
    add("dup-email", "Duplicate emails in the member list", "high", "One person should have one member record.",
      [...byEmail.values()].filter((g) => g.length > 1).flat().map((m) => mItem(m, "Primary Email", m.email, "Merge into one Member ID")));
    const byId = groupBy(M, (m) => m.memberId);
    add("dup-id", "Duplicate Member IDs", "high", "A Member ID must be unique.",
      [...byId.values()].filter((g) => g.length > 1).flat().map((m) => mItem(m, "Member ID", m.memberId, "Assign a new ID")));
    add("dup-response", "Repeated copies of one form response", "high", "The flow appended the same response more than once. Copies are left out of every figure.",
      R.filter((r) => r.excluded === "Repeated copy of the same form response").map((r) => rItem(r, "Form Response ID", r.formResponseId, "Exclude (keep the first row)")));
    add("blank-email", "Members with no email", "medium", "They cannot receive a QR code by email.",
      M.filter((m) => !m.emailN).map((m) => mItem(m, "Primary Email", "", "Collect an email")));
    add("bad-email", "Invalid email format", "medium", "Fails the name@domain.tld pattern.",
      M.filter((m) => m.emailN && !EMAIL_RE.test(m.emailN)).map((m) => mItem(m, "Primary Email", m.email, "Correct the email"))
        .concat(R.filter((r) => r.emailN && !EMAIL_RE.test(r.emailN)).map((r) => rItem(r, "Member Email", r.email, "Correct the email"))));
    add("typo-email", "Email domain looks misspelt", "low", "For example 'homtail.com'. Confirm with the member.",
      M.filter((m) => TYPO_RE.test(m.emailN)).map((m) => mItem(m, "Primary Email", m.email, "Confirm with the member")));
    add("missing-id", "Members without a Member ID", "high", "Every member needs an ID for QR codes.",
      M.filter((m) => !clean(m.memberId)).map((m) => mItem(m, "Member ID", "", "Assign an ID")));
    add("orphan", "Attendance with no matching member", "medium", "The person is not in the member list.",
      R.filter((r) => r.qualifying && r.person && !r.member).map((r) => rItem(r, "Member Key", r.memberKey, "Create or link a member")));
    add("no-person", "Rows that cannot be linked to anyone", "medium", "Broken or empty member key and no email.",
      R.filter((r) => !r.person && r.kind !== "registration" || (r.kind === "registration" && !goodKey(r.keyN) && !r.emailN))
        .map((r) => rItem(r, "Member Key", r.memberKey || "", "Fix the key (E|email)")));
    const active = new Set(R.filter((r) => r.person).map((r) => r.person));
    add("no-activity", "Members with no activity at all", "low", "A member record with no registration or participation row.",
      M.filter((m) => !active.has(m.person)).map((m) => mItem(m, "Member ID", m.memberId, "Review")));
    add("missing-record-id", "Rows without a Record ID", "medium", "Appended by a flow without an ID.",
      R.filter((r) => !clean(r.recordId)).map((r) => rItem(r, "Record ID", "", "Assign the next ID")));
    add("broken-key", "Broken member keys", "medium", "Keys such as '`E' merge different people.",
      R.filter((r) => r.keyN && !/^[epn]\|.+/.test(r.keyN)).map((r) => rItem(r, "Member Key", r.memberKey, r.emailN ? "E|" + r.emailN : "Review")));
    add("name-key", "Matched by first name only", "low", "Name-only keys (N|) can merge two people or split one.",
      R.filter((r) => r.keyN.startsWith("n|")).map((r) => rItem(r, "Member Key", r.memberKey, "Add email or phone")));
    add("dup-participation", "Same person counted twice for one activity", "medium", "For example a QR scan plus a form for the same ride. Counted once.",
      R.filter((r) => r.excluded === "Same person counted twice for the same activity").map((r) => rItem(r, "Record ID", r.recordId || "", "Count once")));
    add("qr-sent-no-date", "QR marked Sent without a date", "medium", "The workbook has no send log yet.",
      M.filter((m) => norm(m.qrStatus) === "sent" && !m.qrCreated).map((m) => mItem(m, "QR Created Date", "", "Confirm the date from Outlook")));
    add("qr-conflict", "Conflicting QR fields", "low", "Status spelling, or Sent while QR Issued = No.",
      M.filter((m) => (norm(m.qrStatus) === "sent" && m.qrIssued !== "Yes") || (m.qrStatus && !["Not Eligible", "Missing Email", "Sent", "Ready to Send", "Issued in App"].includes(m.qrStatus)))
        .map((m) => mItem(m, "QR Status", m.qrStatus, m.qrStatus === "sent" ? "Sent" : "QR Issued = Yes")));
    add("qr-ready-incomplete", "Ready to Send but missing ID or email", "high", "Rule 10: a QR email needs a Member ID and a valid email.",
      M.filter((m) => m.qrStatus === "Ready to Send" && (!clean(m.memberId) || !EMAIL_RE.test(m.emailN))).map((m) => mItem(m, "QR Status", m.qrStatus, "Hold until fixed")));
    const spell = groupBy(R.filter((r) => r.kind === "ride"), (r) => r.series);
    const variants = [];
    for (const [s, g] of spell) { const names = new Set(g.map((r) => String(r.activityName))); if (names.size > 1) for (const r of g) if (String(r.activityName) !== clean(r.activityName) || String(r.activityName).includes(" ")) variants.push(rItem(r, "Activity Name", JSON.stringify(r.activityName), clean(r.activityName))); }
    add("name-variants", "Hidden spaces in activity names", "low", "The same ride is split by invisible characters. Mapped automatically.", variants);
    const comm = groupBy(M, (m) => clean(m.community) || "(blank)");
    add("community", "Community answers are not locations", "info", `Values found: ${[...comm.keys()].join(", ")}. Location comes from the ride instead.`,
      APPROVED_COMMUNITY.length ? [] : []);
    const excluded = R.filter((r) => r.excluded).map((r) => rItem(r, "—", r.excluded, "Left out of figures"));
    return { checks, excluded };
  }

  function groupBy(arr, f) { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

  // ---------- periods ----------
  function previousPeriod(start, end) {
    // whole months / quarters / years step back by the same number of months; anything else by the same number of days
    if (start.slice(8) === "01" && end === monthEnd(end.slice(0, 7))) {
      const n = monthsBetween(start.slice(0, 7), end.slice(0, 7)).length;
      const ps = addMonths(start.slice(0, 7), -n);
      return { start: ps + "-01", end: monthEnd(addMonths(end.slice(0, 7), -n)) };
    }
    const len = diffDays(start, end) + 1;
    return { start: addDays(start, -len), end: addDays(start, -1) };
  }

  // ---------- the main calculation ----------
  /**
   * @param P prepared data  @param f filters {start,end,location,kind,activity,recordType,status,source,activeStatus,memberType}
   * @param asOf "today" (ISO day) — the 90-day active window ends here
   */
  function compute(P, f, asOf, opts) {
    opts = opts || {};
    const start = f.start, end = f.end;
    const personActive = new Map();
    // Active (rule of 1 Oct 2026): a first-time rider is active for 90 days from the first ride;
    // everyone else needs 2 or more rides in the 90 days ending on asOf. Only rides count towards active.
    const inWin = (d) => d <= asOf && d > addDays(asOf, -RULES.activeWindowDays);
    for (const p of P.persons.values()) {
      const n = p.rideDates.filter(inWin).length;
      personActive.set(p.person, n >= RULES.activeMin || (!!p.firstRide && inWin(p.firstRide)));
    }
    const personFilter = !!(f.activeStatus || f.memberType);
    const personOk = (person) => {
      if (!personFilter) return true;
      if (!person) return false;
      const p = P.persons.get(person);
      if (f.activeStatus && (personActive.get(person) ? "Active" : "Inactive") !== f.activeStatus) return false;
      if (f.memberType) { if (!p) return false; const isNew = p.first >= start && p.first <= end; if ((isNew ? "New" : "Returning") !== f.memberType) return false; }
      return true;
    };
    // non-date tests, shared by the period figures and the trend
    const rowTest = (r) => (!f.location || r.location === f.location) && (!f.kind || r.kind === f.kind)
      && (!f.activity || r.activity === f.activity) && (!f.recordType || r.recordType === f.recordType)
      && (!f.status || r.status === f.status) && (!f.source || r.source === f.source) && personOk(r.person);
    const histAllowed = !personFilter && (!f.kind || f.kind === "ride") && (!f.recordType || f.recordType === "Attendance")
      && (!f.status || f.status === "Attended") && (!f.source || f.source === "Historical summary");
    const histTest = (h) => histAllowed && (!f.location || h.location === f.location) && (!f.activity || h.series === f.activity);
    const histEvTest = (h) => !personFilter && (!f.kind || f.kind === "event") && (!f.recordType || f.recordType === "Event Registration") && !f.status
      && (!f.source || f.source === "Historical summary") && !f.location && (!f.activity || h.name === f.activity);
    const inP = (x) => x.d >= start && x.d <= end;
    const rowOk = (r) => inP(r) && rowTest(r), histOk = (h) => inP(h) && histTest(h), histEvOk = (h) => inP(h) && histEvTest(h);

    const live = P.rows.filter((r) => !r.excluded && rowOk(r));
    const Q = live.filter((r) => r.qualifying);
    const QP = Q.filter((r) => r.person);
    const rideLive = Q.filter((r) => r.kind === "ride");
    const rideLiveCounted = rideLive.filter((r) => !r.coveredByHistory);
    const hist = P.historyRides.filter(histOk);
    const histEvAll = P.historyEvents.filter(histEvOk);
    const histEv = histEvAll.filter((h) => !h.separate);
    const eventRows = Q.filter((r) => r.kind === "event" && !r.separate);
    const largeRows = Q.filter((r) => r.kind === "event" && r.separate);
    const histEvLarge = histEvAll.filter((h) => h.separate);

    // members
    const memberOk = (m) => !personFilter || personOk(m.person);
    const membersAtEnd = P.members.filter((m) => day(m.firstSeen) <= end && memberOk(m));
    const newMembers = P.members.filter((m) => day(m.firstSeen) >= start && day(m.firstSeen) <= end && memberOk(m));
    const activeMembers = P.members.filter((m) => personActive.get(m.person) && memberOk(m));
    const allMembers = P.members.filter(memberOk);

    // participants
    const participants = new Set(QP.map((r) => r.person));
    let returning = 0, firstTimers = [];
    for (const id of participants) { const p = P.persons.get(id); if (p.first < start) returning++; else firstTimers.push(p); }
    const retention = {};
    for (const n of [30, 60, 90]) {
      const elig = firstTimers.filter((p) => p.first <= addDays(asOf, -n));
      const kept = elig.filter((p) => p.dates.some((d) => d > p.first && diffDays(p.first, d) <= n));
      retention[n] = { eligible: elig.length, retained: kept.length, rate: elig.length ? kept.length / elig.length : null };
    }
    const regCohort = newMembers.filter((m) => day(m.firstSeen) <= addDays(asOf, -30));
    const regConverted = regCohort.filter((m) => { const p = P.persons.get(m.person); return p && p.dates.some((d) => d >= day(m.firstSeen)); });

    // sessions & ride attendance (history wins on the dates it covers)
    const liveSessions = new Set(rideLiveCounted.map((r) => r.d + "|" + r.series));
    const rideAttendance = hist.reduce((a, h) => a + h.attendees, 0) + rideLiveCounted.length;
    const events = new Set(eventRows.map((r) => r.activity).concat(histEv.map((h) => h.name + "|" + h.m)));
    // second ride within 90 days of a first ride (first-timers whose first ride is old enough to measure)
    const riders1 = [...P.persons.values()].filter((p) => p.firstRide && p.firstRide >= start && p.firstRide <= end && personOk(p.person) && p.firstRide <= addDays(asOf, -RULES.activeWindowDays));
    const second = riders1.filter((p) => p.rideDates.some((d) => d > p.firstRide && diffDays(p.firstRide, d) <= RULES.activeWindowDays));

    // follow-up (as of today)
    const followUp = [];
    for (const p of P.persons.values()) {
      if (!p.member || !personOk(p.person)) continue;
      if (!p.lastRide) continue;
      const since = diffDays(p.lastRide, asOf);
      if (p.rideDates.length > 1 && since > RULES.lapseDays && since <= RULES.lapseLookbackDays) followUp.push({ ...pick(p), reason: `Last ride ${since} days ago` });
      else if (p.rideDates.length === 1 && since >= RULES.newNoReturnDays && since <= RULES.lapseLookbackDays) followUp.push({ ...pick(p), reason: `First ride ${since} days ago, no second ride yet` });
    }
    followUp.sort((a, b) => a.last.localeCompare(b.last));

    const qr = { notEligible: 0, ready: 0, sent: 0, missingEmail: 0, other: 0 };
    for (const m of allMembers) { const s = norm(m.qrStatus); if (s === "sent") qr.sent++; else if (s === "ready to send") qr.ready++; else if (s === "missing email") qr.missingEmail++; else if (s === "not eligible") qr.notEligible++; else qr.other++; }

    const k = {
      uniqueMembers: membersAtEnd.length, newMembers: newMembers.length,
      activeMembers: activeMembers.length, inactiveMembers: allMembers.length - activeMembers.length,
      qualifying: QP.length, rideSessions: hist.length + liveSessions.size, events: events.size,
      eventRegistrations: eventRows.length, eventParticipation: eventRows.length + histEv.reduce((a, h) => a + h.attendance, 0),
      rideAttendance, participants: participants.size, returning, firstTimers: firstTimers.length,
      avgPerMember: participants.size ? QP.length / participants.size : null,
      retention, regConversion: { cohort: regCohort.length, converted: regConverted.length, rate: regCohort.length ? regConverted.length / regCohort.length : null },
      firstToActive: { eligible: riders1.length, retained: second.length, rate: riders1.length ? second.length / riders1.length : null },
      largeEvents: { events: new Set(largeRows.map((r) => r.activity).concat(histEvLarge.map((h) => h.name + "|" + h.m))).size, attendance: largeRows.length + histEvLarge.reduce((a, h) => a + h.attendance, 0),
        names: [...new Set(largeRows.map((r) => r.activity).concat(histEvLarge.map((h) => h.name)))] },
      followUp: followUp.length, qrReady: qr.ready, qrSent: qr.sent,
      recordsWithErrors: P.quality.flaggedRecords, excludedRows: P.rows.filter((r) => r.excluded && r.d >= start && r.d <= end).length,
      historyUsed: hist.length > 0 || histEv.length > 0,
      rideCoverage: !P.historyEnd ? "live" : end <= P.historyEnd ? "history" : start > P.historyEnd ? "live" : "mixed",
      rideHistoryShare: rideAttendance ? hist.reduce((a, h) => a + h.attendees, 0) / rideAttendance : 0, liveReplacedByHistory: rideLive.length - rideLiveCounted.length,
    };
    if (opts.light) return { kpis: k };

    // ---------- breakdowns ----------
    const sum = (m, key, v) => m.set(key, (m.get(key) || 0) + v);
    const bySeries = new Map(), byLocation = new Map(), sessionsBySeries = new Map();
    for (const h of hist) { sum(bySeries, h.series, h.attendees); sum(byLocation, h.location, h.attendees); sum(sessionsBySeries, h.series, 1); }
    for (const r of rideLiveCounted) { sum(bySeries, r.series, 1); sum(byLocation, r.location, 1); }
    for (const s of liveSessions) sum(sessionsBySeries, s.split("|")[1], 1);
    const byEvent = new Map();
    for (const r of eventRows) sum(byEvent, r.activity, 1);
    for (const h of histEv) sum(byEvent, h.name, h.attendance);   // large events are reported separately
    const bySource = new Map();
    for (const r of Q) sum(bySource, r.source, 1);
    if (hist.length) sum(bySource, "Historical summary (headcounts)", hist.reduce((a, h) => a + h.attendees, 0));
    const byType = new Map([["Rides", rideAttendance], ["Events", k.eventParticipation]]);

    const activities = [...bySeries.entries()].map(([name, att]) => ({ name, kind: "Ride", attendance: att, sessions: sessionsBySeries.get(name) || 0, perSession: (sessionsBySeries.get(name) || 0) ? att / sessionsBySeries.get(name) : 0 }))
      .concat([...byEvent.entries()].map(([name, att]) => ({ name, kind: "Event", attendance: att, sessions: 1, perSession: att })));
    activities.sort((a, b) => b.perSession - a.perSession);

    // ---------- monthly & quarterly trend ----------
    // trend shows the selected period, widened to at least 12 months for context, never before the data starts
    let trendStartM = [start.slice(0, 7), addMonths(end.slice(0, 7), -11)].sort()[0];
    if (trendStartM < P.dataStart.slice(0, 7)) trendStartM = P.dataStart.slice(0, 7);
    const months = monthsBetween(trendStartM, end.slice(0, 7));
    const tf = { ...f, start: months[0] + "-01", end };
    const T = trendRows(P, tf, rowTest, histTest, histEvTest);
    const trend = months.map((m) => ({ month: m, inPeriod: m >= start.slice(0, 7), ...T.get(m) }));
    const qMap = new Map();
    for (const t of trend) { const q = quarterOf(t.month + "-01"); const o = qMap.get(q) || { quarter: q, rideAttendance: 0, qualifying: 0, eventParticipation: 0, newMembers: 0 }; o.rideAttendance += t.rideAttendance; o.qualifying += t.qualifying; o.eventParticipation += t.eventParticipation; o.newMembers += t.newMembers; qMap.set(q, o); }

    // ---------- people ----------
    const perPerson = new Map();
    for (const r of QP) sum(perPerson, r.person, 1);
    const engaged = [...perPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ ...pick(P.persons.get(id)), inPeriod: n, active: !!personActive.get(id) }));

    return {
      kpis: k, trend, quarterly: [...qMap.values()],
      bySeries: toList(bySeries), byLocation: toList(byLocation), byEvent: toList(byEvent), bySource: toList(bySource), byType: toList(byType),
      activities, engaged, followUp, qr,
      rows: live, history: hist, historyEvents: histEv, asOf, start, end,
    };
  }
  function pick(p) { return { person: p.person, label: p.label, memberId: p.member ? p.member.memberId : null, first: p.first, last: p.last, total: p.dates.length, rides: p.rideDates.length, lastRide: p.lastRide }; }
  function toList(m) { return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value); }

  function trendRows(P, f, rowTest, histTest, histEvTest) {
    const out = new Map();
    const z = () => ({ largeEvents: 0, rideAttendance: 0, rideHistory: 0, qualifying: 0, eventParticipation: 0, newMembers: 0, firstTimers: 0, returning: 0, sessions: 0 });
    const at = (m) => { if (!out.has(m)) out.set(m, z()); return out.get(m); };
    const inR = (x) => x.d >= f.start && x.d <= f.end;
    const seenPM = new Set(), sess = new Set();
    for (const r of P.rows) {
      if (r.excluded || !r.qualifying || !inR(r) || !rowTest(r)) continue;
      const o = at(r.m);
      if (r.person) o.qualifying++;
      if (r.kind === "ride" && !r.coveredByHistory) { o.rideAttendance++; const s = r.d + "|" + r.series; if (!sess.has(s)) { sess.add(s); o.sessions++; } }
      if (r.kind === "event" && !r.separate) o.eventParticipation++;
      if (r.kind === "event" && r.separate) o.largeEvents++;
      if (r.person && !seenPM.has(r.person + r.m)) { seenPM.add(r.person + r.m); if (P.persons.get(r.person).first.slice(0, 7) === r.m) o.firstTimers++; else o.returning++; }
    }
    for (const h of P.historyRides) if (inR(h) && histTest(h)) { const o = at(h.m); o.rideAttendance += h.attendees; o.rideHistory += h.attendees; o.sessions++; }
    for (const h of P.historyEvents) if (inR(h) && histEvTest(h)) { if (h.separate) at(h.m).largeEvents += h.attendance; else at(h.m).eventParticipation += h.attendance; }
    for (const m of P.members) { const d = day(m.firstSeen); if (d >= f.start && d <= f.end) at(month(d)).newMembers++; }
    return { get: (m) => out.get(m) || z() };
  }

  /** Plain-language commentary built ONLY from calculated values (no explanations invented). */
  function commentary(cur, prev, labels) {
    const items = [];
    const pct = (a, b) => (b ? (a - b) / b : null);
    const say = (name, a, b, upGood = true) => {
      const p = pct(a, b);
      if (b == null) return null;
      if (a === b) return { text: `${name} was unchanged at ${fmt(a)}.`, dir: 0 };
      const dir = a > b ? 1 : -1;
      const pctTxt = p == null ? "" : ` (${p > 0 ? "+" : ""}${Math.round(p * 100)}%)`;
      return { text: `${name} ${dir > 0 ? "rose" : "fell"} from ${fmt(b)} in ${labels.prev} to ${fmt(a)} in ${labels.cur}${pctTxt}.`, dir, good: (dir > 0) === upGood, p };
    };
    const K = cur.kpis, Pk = prev.kpis;
    // ride figures switch from historical headcounts to registered riders on the day the history ends;
    // when the two periods use a different mix, a rise or fall would be an artefact, so say so instead
    const mixChanged = isMixChanged(K, Pk);
    if (mixChanged) items.push({ key: "rideAttendance", dir: 0, notComparable: true,
      text: `Ride attendance was ${fmt(K.rideAttendance)} in ${labels.cur} and ${fmt(Pk.rideAttendance)} in ${labels.prev}. These are not comparable: historical headcounts (all riders) end part-way through this comparison, and after that only registered riders are counted.` });
    for (const [name, key, up] of [["Ride attendance", "rideAttendance", true], ["Ride sessions", "rideSessions", true], ["Qualifying participations", "qualifying", true],
      ["Event participation", "eventParticipation", true], ["New members", "newMembers", true], ["Members taking part", "participants", true]]) {
      if (mixChanged && (key === "rideAttendance" || key === "rideSessions")) continue;
      const s = say(name, K[key], Pk[key], up); if (s) items.push({ key, ...s });
    }
    const achievements = items.filter((x) => x.dir > 0 && x.good && (x.p == null || x.p >= 0.1)).map((x) => x.text);
    const risks = items.filter((x) => x.dir < 0 && (x.p == null || x.p <= -0.1)).map((x) => x.text);
    if (K.followUp) risks.push(`${fmt(K.followUp)} members are due a follow-up (lapsed or no second visit).`);
    if (mixChanged) risks.push("Ride headcounts stop at the end of the historical summary; later months count registered riders only.");
    if (K.recordsWithErrors) risks.push(`${fmt(K.recordsWithErrors)} records have a data-quality issue awaiting review.`);
    const actions = [];
    if (K.followUp) actions.push(`Contact the ${fmt(K.followUp)} members on the follow-up list.`);
    if (K.qrReady) actions.push(`Review the ${fmt(K.qrReady)} QR codes marked Ready to Send.`);
    if (K.recordsWithErrors) actions.push("Work through the open items on the Data quality page.");
    const r30 = K.retention[30];
    if (r30.rate != null && r30.rate < 0.5) actions.push(`Fewer than half of first-time riders (${Math.round(r30.rate * 100)}%) came back within 30 days; consider a welcome follow-up.`);
    return { summary: items.map((x) => x.text), achievements, risks, actions };
  }
  /** Ride figures are like-for-like only when both periods sit on the same side of the history end date. */
  function isMixChanged(a, b) { return !!(a && b && (a.rideCoverage !== b.rideCoverage || a.rideCoverage === "mixed")); }
  function fmt(n) { return n == null ? "—" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: 1 }); }

  const api = { RULES, prepare, compute, commentary, isMixChanged, previousPeriod, classify, locationOf, helpers: { addDays, diffDays, addMonths, monthEnd, monthsBetween, quarterOf, clean, norm } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.WMFEngine = api;
})(typeof self !== "undefined" ? self : this);
