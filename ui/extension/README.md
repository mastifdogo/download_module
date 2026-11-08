# Send to Ledger: browser extension

Part of the [Downloads module](../../README.md) for Ledger. It sends files from your browser
straight to your Ledger server, without saving them to your computer first. Works in **Chrome**
(and Edge, Brave, other Chromium browsers) and **Firefox** 128 or newer.

- **Right-click a download link** on your bank's or a supplier's site and choose **Send to
  Ledger…**. The file is downloaded in that tab, with that site's login, and a small window asks
  where it goes.
- **Toolbar button:** drop a file you already have (or choose one).
- **Destinations:**
  - **Downloads inbox** (the default): any file, up to the module's size limit (25 MB unless
    changed). Larger files are sent in pieces.
  - **Auto sort** (if that module is installed): statements (CSV, OFX, QFX, QBO) are staged for
    review with an account; bills (PDF, EML) go to its Bills tab.
  - **Ledger's CSV files** for journal import.

  It remembers where you last sent each kind of file.

## Install

The easiest way is the **Get the browser extension** button on the Downloads page in Ledger,
which downloads this folder as a zip. Or take `ui/extension/` from this repository.

**Chrome, Edge, Brave**
1. Unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and
   choose the folder.
2. Open the extension's options (**Details → Extension options**). Enter your Ledger address
   (e.g. `http://192.168.1.50:8080`), press **Save**, allow access, then press **Test**.

**Firefox**
- **To try it:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose
  `manifest.json`. It stays until Firefox restarts.
- **To keep it:** regular Firefox only installs signed add-ons. Sign it for yourself (free, not
  listed publicly): create an account on [addons.mozilla.org](https://addons.mozilla.org/developers/),
  then in this folder run `npx web-ext sign --channel unlisted --api-key … --api-secret …` and
  install the `.xpi`. (Developer Edition, Nightly and ESR can instead set
  `xpinstall.signatures.required` to `false` in `about:config` and install an unsigned zip.)
- Then open the add-on's **Options**, enter your Ledger address, **Save**, allow access, **Test**.

## How it signs in

It uses your normal Ledger login in the same browser and stores only Ledger's address, never a
password. Ledger accepts requests only from its own pages: its login cookie is `SameSite=Strict`,
and it refuses cross-site changes. So the extension makes each request *inside a Ledger tab*. It
uses an open one if there is one; otherwise it opens a hidden one and closes it again. Ledger's
protections stay on.

**Permissions:**
- **Your Ledger address only:** asked for when you press Save in the options.
- **activeTab:** to download the link you right-clicked, in that page.
- **scripting**, **tabs**, **contextMenus**, **storage**.

It collects no data.

## Limits

- **Links that won't download:** some banks build the export in the page (a `blob:` link) or need
  a form submission. *Send to Ledger…* then says it couldn't download the file. Save it normally
  and drop it on the toolbar button.
- **Auto sort sizes:** statements up to about 1 MB and bills up to 700 KB (that module's limits).
  Larger files can go to the inbox.
