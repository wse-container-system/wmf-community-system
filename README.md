# WMF Community System

Women Moving Forward's community management and reporting system. It covers:

- ride check-in using the QR codes members already have;
- member registration;
- event sign-up;
- the member list, with a change history;
- the dashboard.

It runs on **Render**: a Node.js web service plus a Postgres database.

## What it does

| Who | What they can do |
|---|---|
| **Community members** (no login) | Register at `/join` and get their personal QR code on screen. Sign up for events at `/events`. |
| **Ride leads** (Coordinator) | Scan QR codes at `/scan` with the phone camera. They can also check people in by name or register a walk-in. They can see members and edit them, giving a reason, and add rides and events. |
| **Administrator** | Everything Coordinators can do, plus: import the workbook, download backups, manage staff accounts, settings and the audit log, merge duplicates, and void wrong check-ins. |
| **Viewer** (managers) | The dashboard and reports, without names or emails. |
| **Sponsor** | The dashboard with anonymised figures. Small counts show as "<5". |

### The QR codes already sent still work
Each code holds the member's ID, for example `WMF-000123`. The import keeps every Member ID and QR value exactly as it is in the workbook. New members continue from the next number.

### Rules the system follows
- One member record per person. Emails are compared in lower case, and a duplicate email or mobile is refused.
- Each person counts once per ride series per day: a second scan just confirms. Each person registers once per event.
- Every edit, merge, void, import and export is written to the audit log, along with who did it and why.
- Nothing is changed automatically. Data-quality issues show on the dashboard's Data quality page for review.
- **The app sends no email.**
- Dashboard figures follow the counting rules agreed on 1–2 Oct 2026. The test `test/reconcile.test.js` imports the 30 Sep workbook and checks that the agreed figures come out exactly.

## Deploy on Render

1. Push this repository to GitHub.
2. In Render, go to **New → Blueprint** and pick the repository. Render reads `render.yaml` and creates:
   - the web service `wmf-community`;
   - the database `wmf-db`.
   Both use the free plans and the Frankfurt region. **The region can't be changed later.**
3. When Render asks, fill in:
   - `ADMIN_EMAIL`: your email.
   - `ADMIN_PASSWORD`: a temporary password. You'll be asked to choose a new one at first sign-in.
4. Open the site address Render gives you and sign in.
5. Go to **Admin → Import** and choose `WMF_Community_Master_System_Integrated.xlsx`. Check the preview, then confirm.
6. Go to **Admin → Staff accounts** and add the ride leads (Coordinator), managers (Viewer) and sponsors.
7. Go to **Rides & events** and check that each weekday ride you run is listed and marked Active.

### Free plan limits

- **The free database is deleted 30 days after it is created** (plus 14 days' grace).
  - Download a backup from **Admin** regularly.
  - Before you rely on the system, upgrade the database to **Basic (about $6/month)**.
- **The free web service sleeps after 15 minutes with no visitors.** The first visit then takes about a minute.
  - Open `/scan` a few minutes before each ride.
  - Or upgrade the web service to **Starter ($7/month)**.

### Moving from the Excel and Forms process
After the import, record new rides, registrations and event sign-ups only in the app. Keep the old forms open for a short overlap. Then close them, so the same attendance isn't recorded in two places.

## Run locally

```bash
npm ci
DATABASE_URL=postgres://postgres@localhost:5432/wmf ADMIN_EMAIL=you@example.org ADMIN_PASSWORD=ChangeMe12345 npm start
```

## Tests

```bash
# full end-to-end flow (wipes the given database)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/wmf_test TEST_WORKBOOK=./WMF_Community_Master_System_Integrated.xlsx npm test
# agreed reference figures, from the 30 Sep 2026 workbook
TEST_DATABASE_URL=… RECONCILE_WORKBOOK=./old-workbook.xlsx npm test
```

## Where things are

| Path | What it is |
|---|---|
| `src/server.js` | Pages and the API: scanner, registration, events, members and rides. |
| `src/admin.js` | Import, export, accounts, settings and the audit log. |
| `src/engine.js` | The dashboard calculations. The same file runs in the browser. |
| `src/importer.js` / `src/exporter.js` | Reading the workbook in, and writing the backup workbook out. |
| `src/rules.js` | Matching members, Member IDs, duplicate checks and UAE time. |
| `public/` | The dashboard, the scanner script and the styles. |
