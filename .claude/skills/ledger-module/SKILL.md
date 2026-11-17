---
name: ledger-module
description: Work on this Ledger module (the Downloads module and its Send to Ledger browser extension, a plugin for the Ledger bookkeeping app installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## Push to `main` without asking

**When work on this module is finished and its checks pass, commit and push
it to `main` of this repository straight away. Do not ask "shall I push?",
do not wait for a go-ahead, do not leave it on a branch, and do not open a
pull request.** The owner has asked for this as a standing rule: every
finished change goes to `main`, where the release workflow publishes the new
version. Asking first is the mistake.

- Bump `version` in `ledger-module.json` in the same push, so it releases.
- After pushing, say what was pushed and the new version; don't ask whether
  to release it, it already is.
- If your environment gives you a different work branch, push there as it
  requires and then to `main` as well.
- Don't push only if: the checks fail; the user said in this conversation
  not to; or the change belongs in Ledger's repository, not this one.

## 1. Get a Ledger checkout and read the module API

The API reference and the full workflow live in the Ledger repository.

- Use `$LEDGER_DIR`, a sibling checkout (`../Accounting`, `../Bookeeping`),
  or clone one: `git clone --depth 1 https://github.com/mastifdogo/Bookeeping /tmp/ledger-for-modules`
  (`scripts/check.sh` does this for you).
- Read **`<ledger>/docs/MODULE_LLM_CONTEXT.md`** in full before changing
  anything: manifest, `ctx` API and return shapes, `ctx.settings`,
  `ctx.dashboard`, `ctx.llm`, `ctx.gmail`, `ctx.search`, `ctx.files`,
  `ctx.orgs`, roles, migrations, UI and security rules.
- Then follow **`<ledger>/.claude/skills/ledger-module/SKILL.md`** (design
  rules, implementation rules, checks, publishing). Treat this repository as
  the module directory it talks about. Where the docs and Ledger's code
  disagree, the code wins (`backend/src/module-host.ts`, `modules.ts`,
  `module-settings.ts`).

Set `"ledger": ">=x.y.z"` in the manifest to the oldest Ledger with every
feature the module uses (the context file says which version added what;
`git -C <ledger> describe --tags --abbrev=0` is the latest release).

## 2. Rules that bite

- No npm packages at runtime: Ledger installs the release as-is. Only
  `node:*` built-ins, global `fetch`, and this repo's own files. (A
  `package.json` here is only for running tests.)
- Never edit a released migration; add the next `NNN_name.sql`.
- Money is integer cents per currency; post to the books only with
  `ctx.ledger.createJournalEntry(entry, req.user)`.
- AI goes through `ctx.llm` (any provider, Ledger 0.18.2: never branch on
  `status().provider` or name a provider in prompts or UI; go by
  `configured`, `images.configured`, `readsPdf`, and validate `json()` data)
  and mail through `ctx.mail` (Ledger 0.18.3: the mailbox under Settings →
  Mail, IMAP or Gmail). No IMAP, SMTP, OAuth or API keys of the module's own.
- **PDFs, and PNG/JPEG scans, go in Ledger's PDF store** (`ctx.documents`,
  Ledger 0.19.0), filed with `add({ origin: "imported" }, req.user)`; only
  the document id is kept. Never in `ctx.storage` or `bytea` columns.
- Files for other modules go through `ctx.files` (Ledger ≥ 0.11.0), never
  another module's tables: pick receivers from `ctx.files.targets(kind)`.
- Organizations (Ledger ≥ 0.11.0): each organization's books and this
  module's schema are a separate database, and requests already run in the
  user's current one, so no organization columns. Background jobs (timers,
  startup) loop over `ctx.orgs.forEach`, or they only see the main books.
- Configuration goes in the manifest's `settings.fields`. Each organization
  has its own values (Ledger ≥ 0.11.1): call `ctx.settings.get()` where
  they're used (inside `ctx.orgs.forEach` for background work), never one
  cached copy.
- AI only proposes; a person approves: `ctx.llm` output is stored as a
  pending suggestion, shown in the UI, and acted on only by an explicit POST
  from a user (`req.user`), who can edit or reject it. Never act on it from a
  background job or `onReceive`, and no auto-approve setting.
- Backups (Ledger ≥ 0.13.0) save every table of this schema as a CSV in each
  backup's folder, next to the dump: keep table and column names readable,
  and no secrets in tables. `file_chunks` holds every file's bytes, so it is
  the big one on older Ledger; from 0.13.2 files live in `ctx.storage` and
  backups carry them as real files. From Ledger 0.13.1 binary columns show
  only their size in the CSV (0.13.0 wrote base64, which a large inbox can
  make fail). A file's
  name, type, size, hash and dates are readable in `files`, which
  `file_chunks.file_id` points to.
- Restores (Ledger ≥ 0.14.0) replace this schema's tables and its
  `ctx.storage` files with a backup's; a restore from an uploaded dump
  (0.14.2) replaces only the tables. So a `files.storage_path` may point at
  nothing (`GET /files` marks it `missing`, `fileBytes` answers 410) and
  stored files may have no row (`removeOrphans` in the hourly clean-up,
  only once they're an hour old: `saveFile` stores before inserting).
  Settings stay as they were. Nothing kept in memory must match the tables
  (scan jobs are in memory and simply end with a restart).
- Accounts (Ledger 0.15–0.16): pickers list accounts tagged `kind`
  (chequing, savings, credit_card) first, then all as a tree by
  `parent_code` (`accountChoices` in ui/index.html); older Ledger has
  neither field and gets one flat list. Import keeps no customer or vendor
  names, so `ctx.entities` doesn't apply; CSV lists can be handed on as
  `entity` files (0.16.0).
- Account codes can be renamed (Ledger 0.19.3): Ledger rewrites codes in
  columns named `account_code` / `*_account_code` / `*_account` and in
  settings whose key contains `account`. Import keeps none: a statement's
  account lives on its document (read fresh in `GET /files`), and notes
  like `sent_to` carry no codes. The extension's remembered `lastAccount`
  just falls back to "Choose…" when it no longer exists.
- Import and Ledger 0.20–0.21: clearing accounts (`kind: "clearing"`) never
  appear in account pickers (`bankAccounts`, the extension's list). In root
  mode (`inRoot(req)`: `req.user.root` and `ctx.root` present, so older
  Ledger is unaffected), `DELETE /files/:id`, `/training/:id` and
  `/extractions/:id` (root only) go through `ctx.root.remove`; a file's
  extractions first; its document and stored copy stay so a reversal is
  whole (orphans are swept after 30 days, not an hour). `ctx.root.onCheck`
  reports files with no content anywhere. `GET /me` gives `root`.
- Ledger runs in a Debian 13 container with PostgreSQL 18 (0.18.0): the server code spawns no programs
  (the scan bridge runs on the user's own computer, not in Ledger).
- Bad input answers 4xx (`throw new ctx.HttpError(422, "…")`), never 500.

## 3. Check before saying it works

```sh
npm test                      # this repo's own tests, if package.json has them
(pg_isready || service postgresql start) >/dev/null
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  sh .claude/skills/ledger-module/scripts/check.sh
```

`check.sh` runs Ledger's checker on this repo: manifest, files, imports,
migrations, then the module loaded into a real Ledger on a scratch database
(every GET route, POST `{}` must give 4xx, UI, settings). Add `--serve 8098`
to keep it running and test the real flows with `curl` and Playwright (it
prints the session cookie). If PostgreSQL has no password yet:
`runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"`.

## Root mode (Ledger ≥ 0.21.1)

An admin can turn on root mode in Ledger. In it they can delete any account,
journal entry, line or user and move a line to any account; entries may be
unbalanced until root mode is left, and anything can be reversed later (the
same ids come back). So an account, entry or user this module kept may be
gone for a while: treat it as gone, don't fail, and don't delete the
module's own records because of it. Also since 0.20.2 an entry's date can
change and a bank line can sit in Ledger's Unreconciled clearing account for
a while: read dates, accounts and amounts from the entry, not from a copy.

Root gets the same power over this module's records. When `req.user.root`
is true (needs `"ledger": ">=0.21.1"`), let the admin delete or change ANY
record of the module, including ones normally protected, and only through
Ledger, never with the module's own DELETE or UPDATE:

- `await ctx.root.remove(req, table, id, "what was deleted")` and
  `await ctx.root.update(req, table, id, { column: value }, summary)`: one
  row of one of the module's tables with an `id` column. They answer 403
  without root, log the action under Settings → Root log, and Ledger puts
  the row back when the action or the whole root session is reversed.
- Remove rows that hang off a row first, one by one (cascaded rows are not
  kept). Don't post or reverse journal entries on a root delete.
- `ctx.root.onCheck(async () => [...])` returns plain sentences for records
  that are truly broken, `[]` when sound; root mode can't be left until then.
- Show root controls only when the server says the user is in root mode,
  marked "Root" in red.

## 4. Release: push to `main`, without asking

Pushing is part of finishing the work (see "Push to `main` without asking" above). Don't ask first.

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

1. Bump `version` in `ledger-module.json` (and note the change in the README):
   new features raise the middle number and reset the last (`1.4.2` →
   `1.5.0`); tweaks and bug fixes only raise the last (`1.4.2` → `1.4.3`); a
   release with both is a feature release.
2. Commit and push `main`. **Don't create tags or Releases by hand**:
   `.github/workflows/release.yml` (the ledger-module skill's
   `assets/release.yml`) tags `v<version>` on that commit and creates the
   Release when a pushed `ledger-module.json` has an unreleased version.
   Check the run in the Actions tab. If it fails with "Resource not
   accessible by integration", the user allows it once: Settings → Actions →
   General → Workflow permissions → "Read and write permissions"; then
   Actions → Release → Run workflow.
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules), or when the server starts if "Update when the
   server starts" is on (Settings → Updates, Ledger 0.12.1). Tell the user
   which of these picks it up; "Update modules now" is the quickest.

## This module: Import (`id: downloads`, kept from its old name Downloads; schema `mod_downloads`)

An inbox for files sent from the browser, plus the Send to Ledger extension
that sends them (`ui/extension/`, Manifest V3 for Chrome and Firefox 128+).

- Needs Ledger ≥ 0.19.0 (`ctx.documents`; `ctx.mail` 0.18.3; `ctx.storage`
  0.13.2). No feature detection for older Ledger any more. Settings:
  `max_file_mb`, `keep_days`, the email check's, `scanner_url`.
- Each organization has its own inbox. The hourly clean-up and the startup
  dashboard notice run through `eachOrg` (`ctx.orgs.forEach`), one
  organization's failure not stopping the others. `max_file_mb` and
  `keep_days` are per organization from Ledger 0.11.1, so `options()` is
  read per request and per organization in the clean-up.
- `POST /files/:id/handoff {to, kind, account_code?}` hands a file to any
  module that accepts that kind (statement, bill, receipt, transaction;
  customer, vendor and entity lists for CSVs, Ledger 0.12.0 / 0.16.0) through `ctx.files` (`GET /targets` lists
  them); `sent_file_id` (migration 002) links the outbox entry so `GET /files`
  shows the receiver's status and result (`handoff`).
- `POST /files/:id/extract` reads a non-CSV file (PDF when the provider
  reads PDFs, a photo or a scanned PDF's JPEG pages (`pdfJpegs`) as `images`
  when `ctx.llm.status().images.configured` (Ledger ≥ 0.11.2, feature-detected
  so 0.11.0–0.11.1 still work), or text) with `ctx.llm.json` into a **pending** row of
  `extractions` (migration 003), and nothing else. The page shows the rows
  for review; `POST /extractions/:id/approve {rows?}` (the person's edits,
  validated strictly) creates the CSV and marks the original sent in one
  claim, `…/reject` discards it. `syncNotice` also keeps the "review"
  dashboard to-do in step with pending extractions.
- Upload API is chunked (512 KiB chunks) to stay under Ledger's 1 MiB JSON
  limit: `POST /files` → `PUT /files/:id/chunks/:i` → `POST /files/:id/complete`.
  Chunks arrive in `file_chunks`; `complete` settles them.
- **Where bytes live** (server.mjs, "Where file bytes live"): `place()` puts
  a PDF/PNG/JPEG (sniffed, ≤ 50 MB) in `ctx.documents` (`files.document_id`,
  `document_added_here`; a 409 duplicate uses the document the error names)
  and anything else in `ctx.storage` (`storage_path`,
  `inbox/<random>/<name>`). `settle()` moves a file that isn't placed yet
  (chunks, or a PDF still in storage from 0.7–0.8); `settleOldFiles` does it
  hourly in batches. **Read bytes only through `fileBytes(f)`.** `discard()`
  removes a deleted file's document only if added here, never sent, and no
  other inbox row points at it. `GET /files` adds `url`, `document: { kind,
  account_code }` and `missing`. Ledger's NotFoundError has no `status`:
  use `notFound404(err)`.
- `POST /files/:id/file-as {kind, account_code?}` sets the document's kind
  (and a statement's account) and marks the file sent; `/handoff` and `/sent
  {kind}` set it too (`DOCUMENT_KIND_OF`). PDFs still go to modules through
  `ctx.files` with `meta.document_id`, until Auto sort reads from the store;
  drop that when it does.
- The page also forwards files to the Auto sort module's own routes
  (`/api/v1/m/categorizer/…`) and to Ledger's `POST /api/v1/files` from the
  browser, then records it with `POST /files/:id/sent`. Auto sort is
  optional: detect it (404 on its routes) and hide those options. Once Auto
  sort accepts files through `ctx.files` (it's listed by `/targets`), the page
  uses that instead and hides its direct options.
- **Email** (`lib/mail.mjs`): through `ctx.mail` only. `messagesSince`
  walks the search back by date (100 a call); `emailCandidates` picks
  attachments by name, type and size before downloading; documents of
  keyword-matching emails become inbox files (`saveFile`, `origin: "email"`),
  bills without attachments `.eml`. `mail_seen` keeps each message once per
  mailbox (`folder` = `<kind>:<account>`, `uidvalidity` 0, `uid` = the
  mail id); `email_check_state` the last check. A minute timer loops
  `ctx.orgs.forEach`; "auto" reads mail only in organization 1. No AI.
  Tests use a stand-in ctx (test/import.test.mjs).
- **Email learning** (`lib/learn.mjs`, migration 005): email files keep
  `mail_features`; `DELETE /files/:id?learn=1` stores an unwanted example,
  sending a file on (`learnKept` in /sent, /handoff, extraction approve) a
  wanted one. `learner()` judges each attachment only against examples from
  its own sender/domain (naive Bayes, skip at ≥ 85% with a matching file
  word, or 3+ deletions and nothing kept). Skips are logged in `mail_seen`
  (`reason`) and can be imported anyway. No AI. Training file:
  `GET/POST /training/file` (`"format": "ledger-import-email-training"`).
- **Scan bridge** (`ui/scan-bridge/`): a USB scanner on a PC shared as eSCL —
  `.ps1` (Windows, WIA COM + HttpListener; can't be run in CI, review by
  hand) and `.py` (SANE scanimage, tested in test/bridge.test.mjs with a
  stand-in scanimage). Both serve the subset lib/escl.mjs uses.
- **Camera receipt detection** (`ui/receipt.js`): Otsu threshold → largest
  light region → convex hull → max-area quad; the person drags the corners;
  `warp` (homography, bilinear) and `cleanUp` (levels). Untrusted results
  fall back to the whole photo.
- **Scanner** (`lib/escl.mjs`): eSCL over node:http/https from the server
  (scanners use self-signed certs), only to local addresses (resolved once,
  checked, then connected to; the job URL must stay on the same host).
  Admins set `scanner_url` (settings) via `POST /scanner` or mDNS
  `POST /scanner/find`. `POST /scans` runs the job in the background (in
  the request's organization) and the page polls `GET /scans/:id`; JPEG
  pages become a PDF (`lib/pdf.mjs`). Tests use a fake eSCL server.
- **Scan** tab (`ui/index.html`, every device): Scanner, Camera (touch
  devices only), Upload files. Camera photos come from `<input type="file"
  capture="environment">` (works inside Ledger's iframe without camera
  permissions, unlike `getUserMedia`), are shrunk on a canvas to JPEG, and
  `jpegsToPdf` writes them as pages of one PDF (DCTDecode, no library). It
  uploads with the same chunked routes as the extension and PATCHes a note;
  no server route of its own. A PDF, so Claude (`ctx.llm` documents) and
  Auto sort bills can read it.
- The extension never talks to Ledger from its own origin: every request
  runs inside a Ledger tab via `chrome.scripting.executeScript({ world:
  "MAIN" })` (Ledger's cookie is SameSite=Strict and it refuses cross-site
  POSTs). Keep it that way; don't add tokens or ask Ledger for exceptions.
- Extension responsiveness (background.js): a menu click starts the download
  in the site's tab and opens the window at once; the popup asks for the
  file with a `pending` message (kept in memory, not session storage: its
  10 MB quota is smaller than files can be). `ledgerTab` reuses one hidden
  helper tab for 45 s when no Ledger tab is open (`warmUp` opens it early);
  `uploadToInbox` sends 3 chunks at a time and posts `progress` messages.
- The page builds the extension zip in the browser from `ui/extension/`
  (the `EXT_FILES` list in `ui/index.html`): add new extension files there.
  It writes this Ledger's origin into `defaults.json` in the zip (the repo's
  copy has an empty address); the extension falls back to it when nothing
  is saved. Missing address or host permission → errors with code `setup`,
  and the popup shows its own setup form (address saved before
  `permissions.request`, which must come straight from the click).
- Sending runs in background.js (`runJob` → `deliver`), not the popup: the
  popup sends `{ type: "send", job, file? }` (no file when a menu click's
  download is held in `pending`) and may be closed. `runJob` waits for the
  download, delivers, and `announce()`s (notification, badge,
  `lastResult` for the popup's next opening). A destination that doesn't
  fit the file (`misfit`) falls back to the Import inbox; other failures
  keep `pending` so Send can be pressed again. The popup shows the form at
  once while a file downloads (`waiting`).
- **Phone app** (`android/`, Kotlin, no server code of its own): logs in
  with a username and password, keeps Ledger's session cookie, and uses the
  same chunked upload routes with `origin: "app"`. Every POST/PUT must send
  a JSON body (`{}` when empty): Android otherwise marks it as a web form
  and Ledger answers 415. `LedgerClient.call(…, org)` puts the session in
  the receipt's organization first (`POST /auth/organization`; a new login
  starts in the user's usual one). `Queue` is files in the app's storage
  (all access under `Queue.LOCK`; `Sender.sending` can't be changed or
  deleted). `Wifi.homeNow` gates sending by itself when a home Wi-Fi is set
  (the name needs the location permission; unknown name on Wi-Fi: try).
  Build: `ANDROID_HOME=… gradle -p android assembleDebug` (SDK platform 35);
  `app.yml` builds it on every push, `release.yml` signs and attaches it.
- Checks: Ledger's checker (`scripts/check.sh`) and
  `npx web-ext lint --source-dir ui/extension` (0 errors expected; the
  `background.service_worker` warning is expected for Firefox).
