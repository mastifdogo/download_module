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
  once. (The same check as the Auto sort module's; see *Email* below.)
- **Scan** tab, on a computer or a phone:
  - **Scanner:** scan on a network scanner or multifunction printer with **AirScan / eSCL** (most
    HP, Canon, Epson, Brother and Xerox models from the last ten years): glass or document feeder,
    colour or grey, resolution, both sides. The Ledger server talks to the scanner, so it works the
    same from any device; the pages become one PDF in the inbox.
  - **Camera** (phones and tablets): take photos of a receipt or bill (or choose them); several
    photos become the pages of one PDF. Photos are shrunk (2000 px) and turned into the PDF on the
    phone; only the PDF is uploaded.
  - **Upload files:** anything from your computer or phone, e.g. a scan made with a USB scanner's
    own app.

  A new scan opens in the inbox with its Send panel ready.
- **Sort it in Ledger:** on the **Import** page each file can be
  - sent on to the [Auto sort](https://github.com/mastifdogo/auto-sort_module) module, as a
    statement whose transactions you review and post, or as a bill or receipt;
  - handed to **any other module that takes files** (Ledger's module file exchange): as a
    statement (with the bank or card account it's for), bill, receipt or transaction list, with the
    receiving module's result shown on the file;
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
  - downloaded, archived or deleted.

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

### Scanner

On the **Scan** tab an admin presses **Find scanners** (the Ledger server looks for AirScan scanners
on its network) and **Use** one, or types its address (on the scanner's screen or network settings
page, e.g. `192.168.1.40`). It's saved as *Network scanner* under Settings → Import. Then anyone can
scan. Only addresses on your local network are accepted (private, link-local, Tailscale, and the
Ledger machine itself).

- **Find scanners finds nothing:** the Ledger server must be on the scanner's network; in a
  container it may need host networking. Enter the address instead.
- **USB scanners** can't be reached from a web page. Use the scanner's own app and **Upload files**,
  or share it on the network with [AirSane](https://github.com/SimulPiscator/AirSane) (on the Ledger
  machine or a Raspberry Pi), which makes it an AirScan scanner.
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
| `GET` | `/scans/:id` | `{status: "scanning"\|"done"\|"error", pages, file_id, file_name, error}` |

`POST /files` also takes `origin`: `"camera"` or `"upload"` (the page sets it); files from email
and the scanner get `origin` `email` / `scanner` and `origin_detail` (the sender, the scanner).

Uploads that never complete are removed after a day.

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
migrations/            files and file_chunks (schema mod_downloads); 002 module hand-offs; 003 AI
                       extractions; 004 file origins, the email log
ui/index.html          the Import page: inbox, forwarding, AI review, Scan (scanner, camera, upload), the extension download
test/                  npm test: email, IMAP, MIME, eSCL (a fake scanner), PDF
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
