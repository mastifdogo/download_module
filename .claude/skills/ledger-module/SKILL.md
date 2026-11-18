---
name: ledger-module
description: Work on this Ledger module (Import, id downloads: since 0.22.0 only the hand-over of its data to Auto sort; a plugin for the Ledger bookkeeping app installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
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

## This module: Import (`id: downloads`; schema `mod_downloads`): the last version

Import is now part of Auto sort (`id: categorizer`, mastifdogo/auto-sort_module). Since 0.22.0
this repository only hands Import's data over; new features go in Auto sort, not here.

- Needs Ledger >= 0.27.0 (one file store: no `ctx.storage.put`, no `bytea` columns).
- `server.mjs`: `GET /status` (the hand-over's state in the request's organization, for the
  page), 410 answers on the routes the old extension and phone app send files to, one dashboard
  notice per organization (fixed key `moved-to-auto-sort` and fixed text, so a dismissed one stays
  dismissed), and the move started in the background at startup.
- `lib/move.mjs`: per organization, a few files per pass, every file in the module's old storage
  is filed in Documents (`ctx.documents.ensure`), the row gets `document_id` (and
  `document_added_here`), `storage_path` is cleared, then the stored copy is removed. Stray stored
  files no row points to are filed too. Safe to run again; passes repeat on an unref'd timer while
  files are left, and `GET /status` starts one when it finds files to move.
- `migrations/013_no_file_chunks.sql` drops `file_chunks` after a guard that stops the update
  while a complete file still has its bytes only there (0.21.1 moves those).
- Auto sort reads `mod_downloads.*` itself (files, extractions, mail_seen, mail_training,
  email_check_state) when an admin presses "Bring over Import's files" there. It never deletes
  from this schema, and it needs every file row to carry `document_id`: don't rename or drop
  these tables or columns.
- The settings were taken out of the manifest; their values stay stored in Ledger.
- The browser extension and the Android app are now released from the Auto sort repository.
  They, the scan bridge and the feature code (`lib/mail.mjs`, `lib/escl.mjs`, …) were removed
  here; their last copies are in this repository's history before 0.22.0.
- Checks: `sh .claude/skills/ledger-module/scripts/check.sh` and `npm test`.
