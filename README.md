# Import: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). It gives Ledger an
**inbox for the files your bookkeeping starts from**: sent from your browser (with the included
**Send to Ledger** extension for Chrome and Firefox), read from **email**, scanned on a **network
scanner** or with a **phone's camera**, or **uploaded**. (It was called *Downloads*; its id is still
`downloads`, so installs and data carry over.)

- **Send from any website:** right-click a download link (a bank statement, a supplier's invoice)
  and choose *Send to Ledger…*, or drop a file on the extension's toolbar button. It goes straight
  to Ledger, without being saved to your computer, using the website's login for the download and
  your Ledger login for the upload.
- **Email:** a scheduled check (hourly by default, or *Check email now*) reads Ledger's Gmail
  account, or any mailbox over IMAP, and imports the documents in emails that look like bills
  (PDFs, CSV/OFX statements, photos of receipts). A bill sent as the email itself is saved as an
  `.eml` file. Nothing is read by AI here and nothing is marked as read; each message is imported
  once. (The same check as the Auto sort module's; see *Email* below.) **It learns from you:**
  delete an email file with *Delete and learn* and later files like it from that sender are
  skipped; files you send on count as wanted. What it learned is a training file you can download
  and load (see *What the email check learns*).
- **Scan** tab, on a computer or a phone:
  - **Scanner:** scan on a network scanner or multifunction printer with **AirScan / eSCL** (most
    HP, Canon, Epson, Brother and Xerox models from the last ten years), or a **USB scanner on a
    computer** through the included scan bridge: glass or document feeder, colour or grey,
    resolution, both sides. The Ledger server talks to the scanner, so it works the same from any
    device; the pages become one PDF in the inbox.
  - **Camera** (phones and tablets): take photos of a receipt or bill (or choose them). Each photo
    is checked for the receipt: its edges are found and shown with corners you can drag, then the
    page is straightened and cropped to the receipt, and optionally cleaned up to black print on
    white. Several photos become the pages of one PDF. It all happens on the phone; only the PDF is
    uploaded.
  - **Upload files:** anything from your computer or phone, e.g. a scan made with a USB scanner's
    own app.

  A new scan opens in the inbox with its Send panel ready.
- **Sort it in Ledger:** on the **Import** page each file can be
  - sent on to the [Auto sort](https://github.com/mastifdogo/auto-sort_module) module, as a
    statement whose transactions you review and post, or as a bill or receipt;
  - handed to **any other module that takes files** (Ledger's module file exchange): as a
    statement (with the bank or card account it's for: accounts tagged chequing, savings or credit
    card come first, sub-accounts under their parent), bill, receipt or transaction list, or a CSV as
    a customer, vendor or customer-and-vendor list (Ledger 0.12.0+ / 0.16.0+), with the receiving
    module's result shown on the file;
  - saved to Ledger's CSV files for journal import;
  - run through **Extract data** (for files that aren't a CSV already: PDFs, photos (JPEG, PNG, GIF,
    WebP) and text files such as TXT, OFX, QFX, HTML, XML, JSON, EML): the LLM set up under
    Settings → LLM API reads its transactions, and you **check them before anything happens**: correct, remove or add rows, then *Approve* (a CSV,
    `Date,Description,Amount,Balance` with money out negative, lands in the inbox ready to send on,
    and the original moves to *Sent*) or *Reject* (nothing is created). A dashboard to-do points to
    extractions waiting for review. Text files go to the LLM connection for text; photos and PDFs to
    the connection for images and documents (Ledger 0.11.2 can have one of each, e.g. a local vision
    model). Claude reads any PDF; another vision model reads scanned PDFs (such as *Scan receipt*
    makes), whose pages are sent as pictures. On Ledger 0.11.0–0.11.1 photos can't be read and PDFs
    need Claude;
  - opened (PDFs, pictures and text, in a new tab; Ledger 0.13.2+), downloaded, archived or
    deleted.

  The extension can also send statements and bills straight to Auto sort.
- **Ledger extras:** a dashboard notification while files are waiting; files show up in Ledger's
  search bar; files that arrived before are flagged.

## Install

Needs **Ledger 0.11.0 or newer**.

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/download_module` and press **Add**.
   **Import** appears in the sidebar.
2. On the Import page, press **Get the browser extension**, download the zip, and install it.
   Chrome: *Load unpacked*. Firefox: a temporary add-on, or one signed for yourself. Details are in
   [ui/extension/README.md](ui/extension/README.md).
3. In the extension's options, enter your Ledger address, **Save**, allow access, and **Test**.

**Options** (Settings → Import; from Ledger 0.11.1 each organization has its own):
- **Largest file accepted:** 25 MB by default, at most 100.
- **Delete sent and archived files after:** a number of days, or 0 to keep them. Files waiting in
  the inbox are never deleted automatically.

Auto sort is optional: without it, the inbox still works, and so do downloading and Ledger's CSV
files.

**Organizations:** each organization in Ledger has its own Import inbox. The extension sends to
the organization you're working in in Ledger at that moment.

**Extract data** needs an AI provider: an admin chooses one under **Settings → LLM API** and ticks
**Import** there. Without it the option is hidden and the Send panel says what to set up.

### Email

Under **Settings → Import**: *Read email from* Gmail (Ledger's account: an admin connects it under
**Settings → Gmail** and allows **Import** to read mail) or another provider over IMAP (server, user
name and app password; `127.0.0.1` works for Proton Bridge). The default reads Gmail in the main
books only, so a second organization doesn't import the same mail. Also: how often, an optional
Gmail search (e.g. `label:bills`), the keywords an email must contain (subject, sender, text or
attachment names), how far back the first check looks, and whether to save bills without
attachments as `.eml` files. The Inbox shows when email was last checked, and a dashboard notice
appears if a check fails.

**If the Auto sort module reads the same mailbox**, both would pick up the same bills: turn its
email off (Settings → Auto sort → *Read bills from* → *Don't read email*) and send the files on from
here (*Auto sort: bill*, or *Extract data*).

### What the email check learns

Deleting a file that came from email asks: **Delete and learn** (files like this aren't wanted) or
**Just delete** (a duplicate, a one-off). Files you send on (to Auto sort, Extract data, another
module, Ledger's CSV files) count as wanted. Each check then scores every attachment against what
you taught about **its own sender**: the sender and its domain, words in the subject and in the file
name, the file type. It's skipped when it looks like what you deleted (85% sure or more), and only
with a file like the deleted ones (a file name word in common, or an email without attachments),
so deleting one sender's `terms-and-conditions.pdf` skips those, not its invoices; a sender whose
files you deleted three times and never kept is skipped whatever the file. A new sender is never
skipped. No AI is involved: it's word counting over your own choices.

*What it learned* (next to *Check email now*) lists the senders with what you deleted and kept, with
*Forget* for each, and the **skipped emails with the reason** and **Import anyway** (which also
teaches it that such files are wanted). **Download the training file** saves everything learned as
JSON (`"format": "ledger-import-email-training"`); **Load a training file** adds one, e.g. in
another organization or after a reinstall; examples it already knows are skipped.

### Scanner

On the **Scan** tab an admin presses **Find scanners** (the Ledger server looks for AirScan scanners
on its network) and **Use** one, or types its address (on the scanner's screen or network settings
page, e.g. `192.168.1.40`). It's saved as *Network scanner* under Settings → Import. Then anyone can
scan. Only addresses on your local network are accepted (private, link-local, Tailscale, and the
Ledger machine itself).

- **Find scanners finds nothing:** the Ledger server must be on the scanner's network; in a
  container it may need host networking. Enter the address instead.
- **USB scanners:** a web page can't reach USB, so the computer the scanner is plugged into (your
  PC, or the Ledger server itself) runs the **scan bridge**, which shares it as an AirScan scanner;
  then it scans from Import on any device. Download it on the Scan tab (*Scanner plugged into a
  computer by USB?*):
  - **Windows:** `ledger-scan-bridge.ps1` uses Windows' own scanner support (WIA), nothing to
    install. Run it once as Administrator (`powershell -ExecutionPolicy Bypass -File
    .\ledger-scan-bridge.ps1` in *Terminal (Admin)*): it reserves port 8090 and opens it in the
    firewall for private networks (if Windows calls your network *Public*, make it *Private*).
  - **Mac and Linux:** `ledger-scan-bridge.py` uses SANE (`brew install sane-backends`, or
    `sudo apt install sane-utils`; version 1.0.28 or newer): `python3 ledger-scan-bridge.py`.
  - It prints the address to enter as the scanner (e.g. `http://192.168.1.25:8090/eSCL`; on the
    Ledger server itself `http://127.0.0.1:8090/eSCL`). Only computers on your local network can
    use it; `-Allow` / `--allow <Ledger server's address>` narrows that. Leave it running.

  Or scan with the scanner's own app and **Upload files**, or use
  [AirSane](https://github.com/SimulPiscator/AirSane), which does the same as the bridge on Linux.
- A scan runs on the server in the background (a feeder of pages takes a while) and becomes a PDF
  with one page per sheet; it must fit the *Largest file accepted* setting.

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
| `GET` | `/ai` | `{configured, allowed, reads_pdf, reads_images, model}`: whether Extract data can be offered, per kind of file |
| `POST` | `/files/:id/extract` | `{instructions?}`: the AI reads a PDF or text file → a **pending** extraction `{id, file_id, rows: [{date, description, amount, balance}], model, currency}`; nothing else changes |
| `GET` | `/extractions?status=pending\|approved\|rejected\|all`, `/extractions/:id` | extractions waiting for review (the list without rows) |
| `POST` | `/extractions/:id/approve` | `{rows?}` (the person's corrected rows; every row needs a real date and amount): creates the CSV in the inbox, marks the original sent → the CSV file |
| `POST` | `/extractions/:id/reject` | discards the suggestion |
| `GET` | `/targets` | modules that take files from other modules, and which kinds |
| `POST` | `/files/:id/handoff` | `{to, kind, account_code?, note?}`: hand the file to that module (`kind`: statement, bill, receipt, transaction); it's marked sent and `GET /files` shows the receiver's `handoff: {status, result}` |
| `PATCH`/`DELETE` | `/files/:id` | `{status: "new"\|"archived", note?, name?}`; delete |
| `GET` | `/mail` | the email check: `{source, setting, interval, missing, state: {last_check_at, error, result}}` |
| `POST` | `/mail/check` | check email now → `{looked_at, files, emails_saved, filtered, …}` |
| `GET` | `/scanner` | the scanner set up: `{configured, reachable, name, sources: [{id, duplex, colorModes, resolutions}], state, adf}` |
| `POST` | `/scanner/find`, `/scanner` | admins: AirScan scanners on the network `{data: [{name, url}]}`; use one `{url}` (`""` forgets it) |
| `POST` | `/scans` | `{source?: "Platen"\|"Feeder", color?: "color"\|"gray", resolution?, duplex?, name?}` → 202 `{id, status}` |
| `GET` | `/mail/skipped` | emails (or some of their files) skipped because of what the check learned, with the reason |
| `POST` | `/mail/skipped/import` | `{folder, uidvalidity, uid}`: import it anyway (and learn it's wanted) |
| `DELETE` | `/files/:id?learn=1` | delete an email file and learn from it → `{deleted, learned}` |
| `GET` | `/training`, `/training/file` | what was learned (senders, recent examples); the training file |
| `POST` | `/training/file`, `/training/forget` | load a training file → `{added, skipped}`; forget `{sender}` or `{all: true}` |
| `GET` | `/me` | `{username, role, ledger, version}` for the page |
| `GET` | `/scans/:id` | `{status: "scanning"\|"done"\|"error", pages, file_id, file_name, error}` |

`POST /files` also takes `origin`: `"camera"` or `"upload"` (the page sets it); files from email
and the scanner get `origin` `email` / `scanner` and `origin_detail` (the sender, the scanner).

Uploads that never complete are removed after a day.

## Backups

**On Ledger 0.13.2 or newer** inbox files are kept in Ledger's file storage (on the data share, per
organization), so every backup folder carries them as **real files** under
`files/downloads/inbox/<folder>/<file name>`, which you can open straight from the backup. Files
from before are moved there a batch at a time (hourly, and any file the moment it's opened or
sent). The tables are also saved as CSVs beside the dump (Ledger 0.13.0+): `files` (each file's
name, type, size, where it came from, `storage_path`), `extractions`, `mail_seen`,
`mail_training`, `email_check_state`, and `file_chunks`, which only holds uploads still arriving
(and, on older Ledger, the files themselves). *Delete sent and archived files after* (Settings →
Import) keeps the inbox, and so the backups, in check. No passwords are kept in tables (the IMAP
password is a protected setting).

**Restores** (Ledger 0.14.0+): restoring an organization's full backup brings back its inbox and
its files together. A restore from an uploaded dump file brings back only the list: files whose
stored copy isn't there are marked *missing* (delete them, or restore a full backup), and stored
files no longer in the list are removed by the hourly clean-up once they're an hour old.

On Ledger 0.13.0 the CSV copies wrote file bytes as base64, which made backups big and could make
them fail with a large inbox; 0.13.1 fixed that. Update Ledger if you're on 0.13.0.

## Privacy

Files are stored in Ledger's database (and its backups) until you delete them, or until the days
set under Settings → Import have passed. The extension sends nothing anywhere but your Ledger.
The email check only reads the mailbox (IMAP read-only, Gmail through Ledger) and keeps a list of
the messages it looked at; scanning talks only to the scanner on your network.
**Extract data** sends that one file's content to the AI provider chosen under Settings → LLM API
(Anthropic's API for Claude, or your own Ollama / OpenAI-compatible server), only when you press
*Extract*.

## Layout

```
ledger-module.json     manifest (settings, drawn download icon)
server.mjs             upload in chunks, the inbox, AI extraction to CSV, scanner routes, clean-up, dashboard, search
lib/mail.mjs           the email check (Gmail through ctx.gmail, or IMAP)
lib/imap.mjs, mime.mjs read-only IMAP client and MIME parser (from the Auto sort module)
lib/escl.mjs           network scanners: eSCL / AirScan, mDNS discovery, local-network check
lib/pdf.mjs            JPEG pages -> PDF
lib/learn.mjs          what the email check learns: features, naive Bayes per sender, training file
migrations/            files and file_chunks (schema mod_downloads); 002 module hand-offs; 003 AI
                       extractions; 004 file origins, the email log; 005 email training; 006 clearer
                       names for Ledger 0.13.0's backup CSVs; 007 storage_path (ctx.storage)
ui/index.html          the Import page: inbox, forwarding, AI review, Scan (scanner, camera, upload), the extension download
ui/receipt.js          finding, straightening and cleaning up a receipt in a photo (canvas, no libraries)
ui/scan-bridge/        the USB scan bridge: Windows (PowerShell, WIA) and Mac/Linux (Python, SANE)
test/                  npm test: email, IMAP, MIME, eSCL (a fake scanner), PDF, learning, the Python scan bridge
ui/extension/          the Send to Ledger browser extension (Manifest V3, Chrome and Firefox)
```

## Development and release

Use the `ledger-module` skill in `.claude/skills/`. `npm test` runs the module's own tests. To check the module against a real Ledger:
`sh .claude/skills/ledger-module/scripts/check.sh` with `TEST_DATABASE_URL` set. To lint the
extension for Firefox: `npx web-ext lint --source-dir ui/extension`.

To release: bump `version` in `ledger-module.json` (and the extension's `manifest.json` if it
changed) and push to `main`. The *Release* workflow (`.github/workflows/release.yml`) then tags
`v<version>` and creates the GitHub Release that Ledger installs. If it fails with "Resource not
accessible by integration", allow it under Settings → Actions → General → Workflow permissions
("Read and write permissions") and run it again from the Actions tab.

## Changes

- **0.8.0:** For Ledger 0.14–0.16: after a restore, inbox files whose stored copy is missing are
  marked (and stored files no longer listed are cleaned up). The statement account picker lists
  accounts tagged chequing, savings or credit card first, and sub-accounts under their parent. CSV
  lists can go to modules that accept customer-and-vendor lists (`entity`).
- **0.7.0:** For Ledger 0.13.2: inbox files are kept in Ledger's file storage instead of the
  database, so backups carry them as real files; older files move there on their own. PDFs,
  pictures and text open in a new tab (*Open*), and downloads come straight from storage. Older
  Ledger keeps working as before.
- **0.6.0:** For Ledger 0.13.0: clearer table and column names for the CSV copies Ledger now saves
  with each backup (`file_chunks.chunk_index`, `email_check_state`, `extractions.transactions`). A
  CSV in the inbox can be sent as a customer or vendor list to a module that keeps them (Ledger
  0.12.0+).
- **0.5.0:** The email check learns: *Delete and learn* on an email file skips files like it from
  that sender later (files sent on count as wanted); skipped emails are listed with *Import
  anyway*; a downloadable training file. USB scanners on a PC (or the Ledger server) through the
  scan bridge (Windows: PowerShell and WIA; Mac and Linux: Python and SANE). The camera finds the
  receipt in each photo, with corners to adjust, then straightens, crops and optionally cleans it
  up. "+ New account…" in the statement account list (Ledger 0.11.3+).
- **0.4.1:** Releases are made by a GitHub workflow when a new version reaches `main`. (Includes
  0.4.0, which was never released on its own.)
- **0.4.0:** Renamed **Import**. Email: imports documents from bill emails (Gmail or IMAP; the
  Auto sort module's check). **Scan** tab on computers and phones: scan on an AirScan network
  scanner (found on the network by an admin), photograph with a phone's camera, or upload files.
  The inbox shows where each file came from. Extension 0.1.1: says *Import*.
- **0.3.0:** For Ledger 0.11.2: *Extract data* reads photos, and scanned PDFs with any vision
  model (their pages go as pictures), through the LLM connection for images; texts say
  *Settings → LLM API*.
- **0.2.0:** A *Scan receipt* tab on phones and tablets: photograph receipts or bills with the
  camera; the photos become one PDF in the inbox.
- **0.1.0:** What the AI extracts is a suggestion you check first: review, correct and approve the
  rows (or reject them) before the CSV is created and the original moves to Sent; a dashboard to-do
  lists extractions waiting for review.
- **0.0.3:** Clean-up uses each organization's own *Delete sent and archived files after* setting
  (settings are per organization from Ledger 0.11.1).
- **0.0.2:** For Ledger 0.11.0: hand files to any module that takes them, and see what it did with
  them; each organization has its own inbox, and clean-up and the dashboard notice run in every
  organization.
- **0.0.1:** Extract data: read a download that isn't a CSV (a PDF or text file) with the AI set
  under Settings → LLM API into a CSV of its transactions.
- **0.0.0:** First release: the inbox and the Send to Ledger extension.
