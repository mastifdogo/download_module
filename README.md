# Import: now part of Auto sort

Import was a module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping): an inbox
for the files bookkeeping starts from (sent from the browser, read from email, scanned, photographed
or uploaded). **All of that now lives in the
[Auto sort](https://github.com/mastifdogo/auto-sort_module) module.** This repository holds the
last version of Import, 0.22.0, which only hands its data over. Its id is still `downloads`.

## What happened

Ledger 0.27.0 keeps every file of every module in one place, Ledger's Documents, and Import's
features were merged into Auto sort (0.17.0 and newer). Import is no longer developed.

## What this version does

- **Takes nothing in.** No email checks, no scanner, no camera or uploads, no AI extraction, no
  sending on. What the old browser extension and phone app send is refused with a message saying
  where to go (HTTP 410).
- **Moves the files Import kept into Ledger's Documents.** PDFs and scans were there already; the
  others (CSV, OFX, saved emails…) were in the module's own storage. At startup, in every
  organization and a few at a time, each is filed in Documents and its inbox entry gets the
  document's id; a file is removed from the old storage only once its entry points at the document.
  Files that had gone missing before (for example after a restore from a dump file) are counted, and
  their entries left as they are.
- **Shows where things stand.** The Import page lists, for the organization you are in, how many
  files Import holds, how many are in Documents, how many are still to move and how many are
  missing, and whether Auto sort is installed. A notice on the dashboard points to it.
- **Changes nothing else.** The inbox entries, what the email check has seen and learned, and the
  AI extractions stay in Import's tables (`mod_downloads`) for Auto sort to read. Import's settings
  stay stored in Ledger.

## What to do

1. **Update Ledger to 0.27.0 or newer**, then update the modules (Settings → Modules → *Update
   modules now*): Import to 0.22.0 and **Auto sort to 0.17.0 or newer**.
2. **Open Auto sort and press "Bring over Import's files"** (an admin, once in each organization).
   Auto sort takes over the inbox, the email check's memory and the AI extractions. Nothing is
   deleted from Import.
3. **Remove Import** under Settings → Modules, once every organization has brought its files over.
   Removing a module keeps its data.

If the update to 0.22.0 is refused with "Import cannot be updated to 0.22.0 yet", a file from a
very old version still has its contents only in Import's own table. Nothing was changed and the
installed Import keeps working: open the files it names on the Import page (that moves them), or
delete them, and update again.

## Browser extension and phone app

The *Send to Ledger* browser extension and the Android app are now part of Auto sort and are
released from [mastifdogo/auto-sort_module](https://github.com/mastifdogo/auto-sort_module). The
ones that came with Import no longer work with it: install the new ones from the Auto sort page in
Ledger. Their source was removed from this repository with 0.22.0 (it is in this repository's
history, up to v0.21.1).

## For developers

Plain JavaScript, no dependencies: `server.mjs` (the state for the page, the 410 answers, the
dashboard notice), `lib/move.mjs` (the move into Documents), `ui/index.html` (the page) and
`migrations/` (013 drops the table that held file bytes, after checking nothing is only there).

```sh
npm test                                              # node --test
sh .claude/skills/ledger-module/scripts/check.sh      # Ledger's module checker (needs a Ledger checkout)
```

Pushing a new `version` in `ledger-module.json` to `main` releases it
(`.github/workflows/release.yml`).
