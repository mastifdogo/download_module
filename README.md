# Downloads: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). It gives Ledger an
**inbox for files sent from your browser**, and includes the **Send to Ledger** browser extension
(Chrome and Firefox) that sends them.

- **Send from any website:** right-click a download link (a bank statement, a supplier's invoice)
  and choose *Send to Ledger…*, or drop a file on the extension's toolbar button. It goes straight
  to Ledger, without being saved to your computer, using the website's login for the download and
  your Ledger login for the upload.
- **Sort it in Ledger:** on the **Downloads** page each file can be
  - sent on to the [Auto sort](https://github.com/mastifdogo/auto-sort_module) module, as a
    statement whose transactions you review and post, or as a bill or receipt;
  - handed to **any other module that takes files** (Ledger's module file exchange): as a
    statement (with the bank or card account it's for), bill, receipt or transaction list, with the
    receiving module's result shown on the file;
  - saved to Ledger's CSV files for journal import;
  - run through **Extract data** (for files that aren't a CSV already: PDFs and text files such as TXT, OFX,
    QFX, HTML, XML, JSON, EML): the AI set up under Settings → AI reads its transactions, and you
    **check them before anything happens**: correct, remove or add rows, then *Approve* (a CSV,
    `Date,Description,Amount,Balance` with money out negative, lands in the inbox ready to send on,
    and the original moves to *Sent*) or *Reject* (nothing is created). A dashboard to-do points to
    extractions waiting for review. PDFs need Claude as the provider; Ollama and OpenAI-compatible
    servers read text files only;
  - downloaded, archived or deleted.

  The extension can also send statements and bills straight to Auto sort.
- **Ledger extras:** a dashboard notification while files are waiting; files show up in Ledger's
  search bar; files that arrived before are flagged.

## Install

Needs **Ledger 0.11.0 or newer**.

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/download_module` and press **Add**.
   **Downloads** appears in the sidebar.
2. On the Downloads page, press **Get the browser extension**, download the zip, and install it.
   Chrome: *Load unpacked*. Firefox: a temporary add-on, or one signed for yourself. Details are in
   [ui/extension/README.md](ui/extension/README.md).
3. In the extension's options, enter your Ledger address, **Save**, allow access, and **Test**.

**Options** (Settings → Downloads; from Ledger 0.11.1 each organization has its own):
- **Largest file accepted:** 25 MB by default, at most 100.
- **Delete sent and archived files after:** a number of days, or 0 to keep them. Files waiting in
  the inbox are never deleted automatically.

Auto sort is optional: without it, the inbox still works, and so do downloading and Ledger's CSV
files.

**Organizations:** each organization in Ledger has its own Downloads inbox. The extension sends to
the organization you're working in in Ledger at that moment.

**Extract data** needs an AI provider: an admin chooses one under **Settings → AI** and ticks
**Downloads** there. Without it the option is hidden and the Send panel says what to set up.

## How files get here

The extension uploads from a Ledger tab with your login (Ledger only accepts its own pages), in
chunks of 512 KB, so each request stays under Ledger's 1 MiB limit:

| Method | Path (under `/api/v1/m/downloads`) | |
|---|---|---|
| `POST` | `/files` | `{name, content_type, size, source_url?}` → `{id, chunk_size, chunks}` |
| `PUT` | `/files/:id/chunks/:index` | `{data: base64}`; each chunk exactly `chunk_size` bytes (the last one, the rest) |
| `POST` | `/files/:id/complete` | checks every chunk arrived, records the SHA-256 → the file (and `duplicate_of` if it arrived before) |
| `GET` | `/files?status=new\|sent\|archived\|all` | the inbox, with counts |
| `GET` | `/files/:id`, `/files/:id/content` | one file; its bytes (base64) |
| `POST` | `/files/:id/sent` | `{to, link?}`: record where the page forwarded it |
| `GET` | `/ai` | `{configured, allowed, reads_pdf, model}`: whether Extract data can be offered |
| `POST` | `/files/:id/extract` | `{instructions?}`: the AI reads a PDF or text file → a **pending** extraction `{id, file_id, rows: [{date, description, amount, balance}], model, currency}`; nothing else changes |
| `GET` | `/extractions?status=pending\|approved\|rejected\|all`, `/extractions/:id` | extractions waiting for review (the list without rows) |
| `POST` | `/extractions/:id/approve` | `{rows?}` (the person's corrected rows; every row needs a real date and amount): creates the CSV in the inbox, marks the original sent → the CSV file |
| `POST` | `/extractions/:id/reject` | discards the suggestion |
| `GET` | `/targets` | modules that take files from other modules, and which kinds |
| `POST` | `/files/:id/handoff` | `{to, kind, account_code?, note?}`: hand the file to that module (`kind`: statement, bill, receipt, transaction); it's marked sent and `GET /files` shows the receiver's `handoff: {status, result}` |
| `PATCH`/`DELETE` | `/files/:id` | `{status: "new"\|"archived", note?, name?}`; delete |

Uploads that never complete are removed after a day.

## Privacy

Files are stored in Ledger's database (and its backups) until you delete them, or until the days
set under Settings → Downloads have passed. The extension sends nothing anywhere but your Ledger.
**Extract data** sends that one file's content to the AI provider chosen under Settings → AI
(Anthropic's API for Claude, or your own Ollama / OpenAI-compatible server), only when you press
*Extract*.

## Layout

```
ledger-module.json     manifest (settings, drawn download icon)
server.mjs             upload in chunks, the inbox, AI extraction to CSV, clean-up, dashboard, search
migrations/            files and file_chunks (schema mod_downloads); 002 links module hand-offs
ui/index.html          the Downloads page: inbox, forwarding, the extension download
ui/extension/          the Send to Ledger browser extension (Manifest V3, Chrome and Firefox)
```

## Development and release

Use the `ledger-module` skill in `.claude/skills/`. To check the module against a real Ledger:
`sh .claude/skills/ledger-module/scripts/check.sh` with `TEST_DATABASE_URL` set. To lint the
extension for Firefox: `npx web-ext lint --source-dir ui/extension`.

To release: bump `version` in `ledger-module.json` (and the extension's `manifest.json` if it
changed), tag `v<version>`, and create a GitHub Release from the tag.

## Changes

- **0.1.0:** What the AI extracts is a suggestion you check first: review, correct and approve the
  rows (or reject them) before the CSV is created and the original moves to Sent; a dashboard to-do
  lists extractions waiting for review.
- **0.0.3:** Clean-up uses each organization's own *Delete sent and archived files after* setting
  (settings are per organization from Ledger 0.11.1).
- **0.0.2:** For Ledger 0.11.0: hand files to any module that takes them, and see what it did with
  them; each organization has its own inbox, and clean-up and the dashboard notice run in every
  organization.
- **0.0.1:** Extract data: read a download that isn't a CSV (a PDF or text file) with the AI set
  under Settings → AI into a CSV of its transactions.
- **0.0.0:** First release: the inbox and the Send to Ledger extension.
