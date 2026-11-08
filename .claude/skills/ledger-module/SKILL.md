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
- AI goes through `ctx.llm` and Gmail through `ctx.gmail` (Ledger ≥ 0.10.0):
  no API keys, OAuth, IMAP or Apps Script bridges of the module's own for
  those. The admin allows the module under Settings → AI / Gmail.
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

## 4. Release (only when the user asks)

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

1. Bump `version` in `ledger-module.json` (and note the change in the README):
   new features raise the middle number and reset the last (`1.4.2` →
   `1.5.0`); tweaks and bug fixes only raise the last (`1.4.2` → `1.4.3`); a
   release with both is a feature release.
2. Commit, tag `v<version>`, push the tag, and create a GitHub Release from
   it (not a draft or pre-release). If tags or releases can't be created from
   this session, tell the user which commit to release in GitHub's web UI.
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules).

## This module: Downloads (`id: downloads`, schema `mod_downloads`)

An inbox for files sent from the browser, plus the Send to Ledger extension
that sends them (`ui/extension/`, Manifest V3 for Chrome and Firefox 128+).

- Needs Ledger ≥ 0.11.0 (`ctx.files`, `ctx.orgs`; before that `ctx.llm`,
  `ctx.settings`, `ctx.search`, `ctx.dashboard`, drawn icon). Settings:
  `max_file_mb`, `keep_days`.
- Each organization has its own inbox. The hourly clean-up and the startup
  dashboard notice run through `eachOrg` (`ctx.orgs.forEach`), one
  organization's failure not stopping the others. `max_file_mb` and
  `keep_days` are per organization from Ledger 0.11.1, so `options()` is
  read per request and per organization in the clean-up.
- `POST /files/:id/handoff {to, kind, account_code?}` hands a file to any
  module that accepts that kind through `ctx.files` (`GET /targets` lists
  them); `sent_file_id` (migration 002) links the outbox entry so `GET /files`
  shows the receiver's status and result (`handoff`).
- `POST /files/:id/extract` reads a non-CSV file (PDF when the provider
  reads PDFs, or text) with `ctx.llm.json` into a new CSV in the inbox.
- Upload API is chunked (512 KiB chunks) to stay under Ledger's 1 MiB JSON
  limit: `POST /files` → `PUT /files/:id/chunks/:i` → `POST /files/:id/complete`.
  Bytes live in `file_chunks`; `GET /files/:id/content` reassembles them.
- The page also forwards files to the Auto sort module's own routes
  (`/api/v1/m/categorizer/…`) and to Ledger's `POST /api/v1/files` from the
  browser, then records it with `POST /files/:id/sent`. Auto sort is
  optional: detect it (404 on its routes) and hide those options. Once Auto
  sort accepts files through `ctx.files` (it's listed by `/targets`), the page
  uses that instead and hides its direct options.
- The extension never talks to Ledger from its own origin: every request
  runs inside a Ledger tab via `chrome.scripting.executeScript({ world:
  "MAIN" })` (Ledger's cookie is SameSite=Strict and it refuses cross-site
  POSTs). Keep it that way; don't add tokens or ask Ledger for exceptions.
- The page builds the extension zip in the browser from `ui/extension/`
  (the `EXT_FILES` list in `ui/index.html`): add new extension files there.
- Checks: Ledger's checker (`scripts/check.sh`) and
  `npx web-ext lint --source-dir ui/extension` (0 errors expected; the
  `background.service_worker` warning is expected for Firefox).
