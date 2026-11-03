# Cycling Development hub

One web app for the Cycling Development department, with three areas reached from the **Hub** (`/`):

| Area | Where | What it does |
|---|---|---|
| **WMF** (WMN Moving FWD) | `/wmf`, `/scan`, `/members`, `/dashboard` … | The community system described below, plus **Export monthly (Excel)** on the dashboard. |
| **Corporate** (L'IMAD, NMDC, Aurora) | `/corporate` | QR self check-in, attendance register, event tracker, participants, staff scanner, dashboard, reports for management and sponsors. |
| **Department** | `/department` | Team attendance, annual leave requests and approvals, balances, public holidays, exports and a feed for HR. |

## WMF monthly export
Dashboard → **Export monthly (Excel)** (top right, and on the Performance and Reports pages). One row per month for the
selected period (a single month exports the 12 months ending with it): ride sessions, ride attendance, average riders per
ride, events, event participation, total attendance, large public events (separate), unique / first-time / returning
participants, new members, active members and total members at month end. Extra sheets: rides by month, events by month,
Impact (retention, conversion), About. Figures use the dashboard's own engine, so they match the screen. Sponsors get
counts below 5 as "<5".

## Corporate Cycling Programme
- **Import the tracker once:** Admin → Corporate settings → upload `CORPORATE_TRACKER_UNIFIED.xlsx`. It reads the Limad and NMDC
  sheets (one row per person), the AURORA sheet (headcounts) and Master Data (fills dates the other sheets don't have, and
  cancellations). The preview lists differences and look-alike names before anything is written.
- **Company QR code** (Corporate → QR codes): print the poster or share the link with the company's staff. People scan with
  the phone camera, type their name (and work email), and they're checked in. No sign-in. It opens the weekly ride by itself
  on the company's ride days, and any scheduled session or event on its day. New names are added as participants.
- **Personal QR codes**: every participant has one (`CORP-NMDC-0012`); ride leads scan them at Corporate → Scan. Printable cards per company.
- **Attendance**: the register looks like the tracker (names × dates). Open a date to tick names, add a walk-in, enter a headcount or cancel it.
- **Events**: running, yoga, workshops and one-off events per partner, scheduled ahead and recorded on the day.
- **Reports**: printable (Print → Save as PDF) and Excel, per company or all, by month, quarter, year or dates, compared with the previous period.
  Viewers and sponsors see no names. In Admin → Staff accounts, a viewer or sponsor can be limited to **one partner** (e.g. the NMDC sponsor):
  they then only see that company's corporate dashboard and report.
- **Tracker export**: Corporate → Attendance → Download tracker gives the same layout as the old Excel (one sheet per company + Master Data).

## Department admin
- Department → **Staff**: add the team with their sign-in email; give them a Coordinator account (Admin → Staff accounts). Add public holidays here too.
- Each person uses **My attendance & leave**: check in (office / remote / at a ride or event), check out, request leave, see their balance.
- Administrators see who's in today, approve or reject leave, and fill in or correct the **Attendance** month (P/R/F/L/S/A/O/H). Approved leave appears by itself.
- Leave counts working days (Mon–Fri) and skips public holidays. Balance = entitlement + carried over − approved annual leave.
- **HR**: Department → HR export gives the monthly attendance (grid + daily records with times) and the leave register as Excel.
  Set `HR_FEED_TOKEN` in Render to switch on CSV feeds (`/api/hr/attendance.csv`, `/api/hr/leave.csv`) that an HR system,
  Power Automate or Excel “Get data from web” can pull.

---

# WMF Community System

Women Moving Forward's community management and reporting system. It covers:

- ride check-in using the QR codes members already have;
- member registration;
- event sign-up;
- the member list, with a change history;
- the dashboard.

It runs on **Render** (the web app) with its data in **Neon** (Postgres).

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
- **Contact details are protected:**
  - Only administrators see members' full email addresses and phone numbers. They press "Show contact details" on a member's page, and each view is logged.
  - Ride leads (Coordinators) see masked details (for example `ma•••@gmail.com`, `•••• 939`) and can't change them.
  - Managers and sponsors never receive names or contact details.
  - Each ride lead can open up to 300 member pages or searches an hour, which stops anyone copying the whole list.
  - The Excel backup needs the administrator's password and is logged.
- Dashboard figures follow the counting rules agreed on 1–2 Oct 2026. The test `test/reconcile.test.js` imports the 30 Sep workbook and checks that the agreed figures come out exactly.

## Deploy on Render (data stored in Neon)

1. In **Neon**, create a project:
   - Name it `wmf` and pick the region closest to the UAE (e.g. AWS Frankfurt or Singapore).
   - Copy the **direct** connection string from the Neon dashboard ("Connect" → turn "Connection pooling" off). It looks like `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
2. Push this repository to GitHub.
3. In Render, go to **New → Blueprint** and pick the repository. Render creates the web service `wmf-community`.
4. When Render asks, fill in:
   - `DATABASE_URL`: the Neon connection string.
   - `ADMIN_EMAIL`: your email.
   - `ADMIN_PASSWORD`: a temporary password. You'll be asked to choose a new one at first sign-in.
5. Open the site address Render gives you and sign in. The app creates its tables in Neon on first start.
6. Go to **Admin → Import** and choose `WMF_Community_Master_System_Integrated.xlsx`. Check the preview, then confirm.
7. Go to **Admin → Staff accounts** and add the ride leads (Coordinator), managers (Viewer) and sponsors.
8. Go to **Rides & events** and check that each weekday ride you run is listed and marked Active.

### Keeping the data safe

- Every check-in, registration and edit is saved in Neon the moment it happens.
- Neon's free plan doesn't expire after 30 days the way Render's free database does. It can also undo changes from the last 6 hours ("instant restore").
- Still download the Excel backup from **Admin** every week, and keep it in SharePoint. That copy is yours whatever happens to either service.
- Neon's free plan pauses the database after 5 minutes with nothing happening. The first request afterwards waits a second or two while it wakes, and no data is lost.

### Free plan limits

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
# hub: corporate, department and the WMF monthly export (wipes the database; tracker optional)
TEST_DATABASE_URL=… TEST_TRACKER=./in/CORPORATE_TRACKER_UNIFIED.xlsx npm test
```

## Where things are

| Path | What it is |
|---|---|
| `src/server.js` | Pages and the API: scanner, registration, events, members and rides. |
| `src/admin.js` | Import, export, accounts, settings and the audit log. |
| `src/engine.js` | The dashboard calculations. The same file runs in the browser. |
| `src/importer.js` / `src/exporter.js` | Reading the workbook in, and writing the backup workbook out. |
| `src/wmfexport.js` | WMF monthly Excel export. |
| `src/corporate.js`, `src/corpdata.js`, `src/corpimport.js`, `src/corpexport.js` | Corporate pages, figures, tracker import, Excel files. |
| `src/department.js` | Department attendance, leave and HR exports. |
| `src/views.js`, `src/charts.js`, `public/hub.css`, `public/ui.js` | Hub layout and navigation, server-drawn charts. |
| `src/rules.js` | Matching members, Member IDs, duplicate checks and UAE time. |
| `public/` | The dashboard, the scanner script and the styles. |
