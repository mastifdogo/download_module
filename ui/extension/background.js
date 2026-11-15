// Send to Ledger: background script (a service worker in Chrome, an event page in Firefox).
// Part of the Import module for Ledger (mastifdogo/download_module): files go to its inbox
// by default, or straight to the Auto sort module or Ledger's CSV files.
//
// Ledger only accepts requests from its own pages: its login cookie is
// SameSite=Strict and it rejects cross-site POSTs. So every request to Ledger
// is made *inside a Ledger tab* (an open one, or a hidden one opened and closed
// again) with scripting.executeScript in the page's own world. It then runs
// exactly like Ledger's page, with your existing login. The extension stores
// no password, only Ledger's address.

const INBOX = "downloads"; // the Import module (id "downloads", this extension's home)
const AUTOSORT = "categorizer"; // the Auto sort module, if installed

async function settings() {
	let { ledgerUrl = "" } = await chrome.storage.local.get("ledgerUrl");
	// A copy downloaded from Ledger's Import page comes with that Ledger's address (defaults.json).
	if (!ledgerUrl) ledgerUrl = await fetch(chrome.runtime.getURL("defaults.json")).then((r) => r.json()).then((d) => String(d.ledgerUrl || ""), () => "");
	return { ledgerUrl: ledgerUrl.replace(/\/+$/, "") };
}

// When no Ledger tab is open, a hidden helper tab is opened (robots.txt: a small same-origin page
// any browser lets extensions script; Firefox doesn't for its JSON viewer). It is kept for a short
// while and reused, since one send makes several calls; opening a tab for each made sending slow.
const HELPER_IDLE_MS = 45_000;
let helper = null; // { tabId, origin, ready: Promise, timer }

function closeHelperLater() {
	if (!helper) return;
	clearTimeout(helper.timer);
	const h = helper;
	h.timer = setTimeout(() => {
		if (helper === h) helper = null;
		chrome.tabs.remove(h.tabId).catch(() => {});
		chrome.storage.session.remove("helperTab").catch(() => {});
	}, HELPER_IDLE_MS);
}

/** A helper tab left behind when the browser stopped this script early: close it. */
async function closeStrayHelper() {
	const { helperTab } = await chrome.storage.session.get("helperTab").catch(() => ({}));
	if (helperTab && helperTab !== helper?.tabId) {
		chrome.tabs.remove(helperTab).catch(() => {});
		chrome.storage.session.remove("helperTab").catch(() => {});
	}
}

/** A tab showing a Ledger page we may script: an open one, or the hidden helper tab. → tab id */
async function ledgerTab(origin) {
	const tabs = await chrome.tabs.query({ url: `${origin}/*` });
	const open = tabs.find((t) => t.status === "complete" && t.id !== helper?.tabId);
	if (open) return open.id;
	if (helper && helper.origin === origin) {
		try {
			await helper.ready;
			await chrome.tabs.get(helper.tabId); // still there?
			closeHelperLater();
			return helper.tabId;
		} catch {
			helper = null;
		}
	}
	await closeStrayHelper();
	const h = (helper = { tabId: 0, origin, ready: null, timer: 0 });
	h.ready = (async () => {
		const tab = await chrome.tabs.create({ url: `${origin}/robots.txt`, active: false });
		h.tabId = tab.id;
		chrome.storage.session.set({ helperTab: tab.id }).catch(() => {});
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				chrome.tabs.onUpdated.removeListener(listener);
				reject(new Error(`Ledger didn't answer at ${origin}`));
			}, 20_000);
			const listener = (id, info) => {
				if (id === tab.id && info.status === "complete") {
					clearTimeout(timer);
					chrome.tabs.onUpdated.removeListener(listener);
					resolve();
				}
			};
			chrome.tabs.onUpdated.addListener(listener);
		});
	})();
	try {
		await h.ready;
	} catch (err) {
		if (helper === h) helper = null;
		if (h.tabId) chrome.tabs.remove(h.tabId).catch(() => {});
		throw err;
	}
	closeHelperLater();
	return h.tabId;
}

/** Gets a Ledger tab ready ahead of time (while a file downloads, or the popup is open), so Send doesn't wait for it. */
async function warmUp() {
	try {
		const { ledgerUrl } = await settings();
		if (!ledgerUrl) return;
		const origin = new URL(ledgerUrl).origin;
		if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) await ledgerTab(origin);
	} catch {
		// the real call will say what's wrong
	}
}

/**
 * Runs in the Ledger page (its own world): one API call with the page's login.
 * req: { method, path, json? , form?: { field, filename, type, base64 } }. Returns { status, body }.
 */
async function callInPage(req) {
	const init = { method: req.method, credentials: "same-origin", headers: {} };
	if (req.json !== undefined) {
		init.headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(req.json);
	} else if (req.form) {
		const bin = atob(req.form.base64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const fd = new FormData();
		fd.append(req.form.field, new Blob([bytes], { type: req.form.type || "application/octet-stream" }), req.form.filename);
		init.body = fd;
	}
	try {
		const r = await fetch(req.path, init);
		const text = await r.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = { error: { message: text.slice(0, 300) } };
		}
		return { status: r.status, body };
	} catch (err) {
		return { status: 0, body: { error: { message: String(err && err.message ? err.message : err) } } };
	}
}

const UPLOADS_AT_ONCE = 3;

/**
 * Uploads a file to the Import inbox in pieces (each request stays under Ledger's 1 MiB limit),
 * a few at a time, telling the popup how far it is. file: { name, type, base64, size, from }.
 */
async function uploadToInbox(file) {
	const base = `/api/v1/m/${INBOX}/files`;
	const start = await ledger({ method: "POST", path: base, json: { name: file.name, content_type: file.type || "", size: file.size, source_url: file.from || "" } });
	const { id, chunk_size } = start;
	const bin = atob(file.base64); // one character per byte
	const total = Math.max(1, Math.ceil(bin.length / chunk_size));
	let next = 0;
	let done = 0;
	const progress = () => chrome.runtime.sendMessage({ type: "progress", done, total }).catch(() => {});
	progress();
	const worker = async () => {
		while (next < total) {
			const i = next++;
			await ledger({ method: "PUT", path: `${base}/${id}/chunks/${i}`, json: { data: btoa(bin.slice(i * chunk_size, (i + 1) * chunk_size)) } });
			done++;
			progress();
		}
	};
	await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, total) }, worker));
	return ledger({ method: "POST", path: `${base}/${id}/complete` });
}

/** Calls Ledger's API through a Ledger tab. Throws a readable Error on failure. */
async function ledger(req) {
	const { ledgerUrl } = await settings();
	if (!ledgerUrl) throw Object.assign(new Error("Set your Ledger address first."), { code: "setup" });
	const origin = new URL(ledgerUrl).origin;
	if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
		throw Object.assign(new Error(`The extension isn't allowed to reach ${origin} yet.`), { code: "setup" });
	}
	const tabId = await ledgerTab(origin);
	{
		const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: callInPage, args: [req] });
		const out = res?.result ?? { status: 0, body: null };
		const path = req.path ?? `/api/v1/m/${INBOX}/`;
		if (out.status === 401) throw Object.assign(new Error("You're not logged in to Ledger in this browser. Log in, then try again."), { code: "login" });
		if (out.status === 404 && path.includes(`/m/${INBOX}/`)) throw new Error("The Import module isn't installed or running in this Ledger (Settings → Modules: mastifdogo/download_module).");
		if (out.status === 404 && path.includes(`/m/${AUTOSORT}/`)) throw Object.assign(new Error("The Auto sort module isn't installed in this Ledger."), { code: "no-autosort" });
		if (out.status < 200 || out.status >= 300) {
			const e = out.body?.error;
			const details = e?.details?.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ");
			throw new Error(details || e?.message || `Ledger answered ${out.status || "nothing"}`);
		}
		return out.body;
	}
}

/** Runs in the page where a link was clicked: downloads it with that site's login. */
async function fetchLinkInPage(url) {
	try {
		const r = await fetch(url, { credentials: "include" });
		if (!r.ok) return { error: `the site answered ${r.status}` };
		const buf = new Uint8Array(await r.arrayBuffer());
		if (buf.length > 100 * 1024 * 1024) return { error: "the file is larger than 100 MB" };
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		const cd = r.headers.get("content-disposition") || "";
		const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(cd);
		let name = m ? decodeURIComponent((m[1] || m[2]).trim()) : "";
		if (!name) name = decodeURIComponent(new URL(r.url).pathname.split("/").pop() || "") || "download";
		return { name, type: r.headers.get("content-type") || "", base64: btoa(bin), size: buf.length };
	} catch (err) {
		return { error: String(err && err.message ? err.message : err) };
	}
}

// --- Right-click a link: "Send to Ledger" -----------------------------------

const PDF_URLS = ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://*/*.PDF?*"];
function setupMenu() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({ id: "send-link", title: "Send to Ledger…", contexts: ["link"] });
		// A PDF shown in the tab, or in a frame of the page (how many banks show statements).
		chrome.contextMenus.create({ id: "send-page", title: "Send this PDF to Ledger…", contexts: ["page"], documentUrlPatterns: PDF_URLS });
		chrome.contextMenus.create({ id: "send-frame", title: "Send this frame's file to Ledger…", contexts: ["frame"] });
	});
}

/** The file a tab is showing (its own address), fetched inside the tab so the site's login applies. */
async function fileOfTab(tab, url = tab.url) {
	if (!/^https?:/i.test(url || "")) throw new Error("This tab isn't a web address the extension can read. Save the file, then drop it here.");
	let file;
	try {
		const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: fetchLinkInPage, args: [url] });
		file = res?.result ?? { error: "no answer from the page" };
	} catch (err) {
		file = { error: err.message };
	}
	if (file.error) throw new Error(`Couldn't get the file from this tab (${file.error}). Download it, then drop it here.`);
	if (/^text\/html/i.test(file.type)) throw new Error("This tab shows a web page, not a file. Right-click the link to the PDF and choose Send to Ledger…, or open the PDF in its own tab first.");
	if (!/\.[a-z0-9]{2,5}$/i.test(file.name) && /pdf/i.test(file.type)) file.name += ".pdf";
	return { ...file, from: url };
}
chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup?.addListener(setupMenu);

// The file a menu click is fetching, for the window that opens straight away: { from, file: Promise }.
// (Kept here, not in storage: files can be larger than session storage allows.)
let pending = null;

async function onLinkMenu(info, tab) {
	if (!tab?.id || !["send-link", "send-page", "send-frame"].includes(info.menuItemId)) return;
	const url = info.menuItemId === "send-link" ? info.linkUrl : info.menuItemId === "send-frame" ? info.frameUrl : info.pageUrl;
	// Start the download in the site's own tab (so its login applies), and open the window at once:
	// it shows that the file is on its way instead of nothing happening until the download ends.
	const fetching =
		info.menuItemId === "send-link"
			? chrome.scripting
					.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: fetchLinkInPage, args: [url] })
					.then(([res]) => res?.result ?? { error: "no answer from the page" }, (err) => ({ error: err.message }))
					.then((file) => (file.error ? { error: `Couldn't download ${url}: ${file.error}. Save the file, then drop it into the extension instead.` } : { ...file, from: url }))
			: fileOfTab(tab, url).catch((err) => ({ error: err.message }));
	pending = { from: url, file: fetching };
	warmUp(); // a Ledger tab, ready by the time Send is pressed
	let host = "";
	let name = "";
	try {
		const u = new URL(url);
		host = u.host;
		name = decodeURIComponent(u.pathname.split("/").pop() || "");
	} catch {}
	// The link's own name, when it has one (statement.pdf): the window offers the fitting choices before the file is here.
	if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = "";
	await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?pending=1&from=${encodeURIComponent(host)}&name=${encodeURIComponent(name.slice(0, 120))}`), type: "popup", width: 460, height: 620 });
}
chrome.contextMenus.onClicked.addListener(onLinkMenu);

// --- Messages from the popup and the options page ---------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	(async () => {
		switch (msg.type) {
			case "whoami":
				return ledger({ method: "GET", path: "/api/v1/auth/me" });
			case "inbox":
				return uploadToInbox(msg.file);
			case "warm-up":
				return void warmUp();
			case "pending": {
				// The file a menu click is fetching: answers when it has arrived.
				const p = pending;
				if (!p) throw new Error("Nothing is waiting to be sent. Right-click the link and choose Send to Ledger… again.");
				const file = await p.file;
				if (pending === p) pending = null;
				return file;
			}
			case "accounts":
				return ledger({ method: "GET", path: `/api/v1/m/${AUTOSORT}/accounts` });
			case "ledger-accounts":
				return ledger({ method: "GET", path: "/api/v1/accounts" });
			case "tab-file": {
				const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
				if (!tab?.id) throw new Error("No tab to read.");
				return fileOfTab(tab);
			}
			case "document": {
				// Into the Import inbox (which files PDFs and scans in Ledger's Documents), then say what it is.
				const f = await uploadToInbox(msg.file);
				return ledger({ method: "POST", path: `/api/v1/m/${INBOX}/files/${f.id}/file-as`, json: { kind: msg.kind, ...(msg.account_code ? { account_code: msg.account_code } : {}) } });
			}
			case "statement":
				return ledger({ method: "POST", path: `/api/v1/m/${AUTOSORT}/statements`, json: msg.body });
			case "bill":
				return ledger({ method: "POST", path: `/api/v1/m/${AUTOSORT}/bills/upload`, json: msg.body });
			case "ledger-file":
				return ledger({ method: "POST", path: "/api/v1/files", form: { field: "file", filename: msg.filename, type: "text/csv", base64: msg.base64 } });
			default:
				throw new Error(`unknown request ${msg.type}`);
		}
	})().then(
		(data) => reply({ ok: true, data }),
		(err) => reply({ ok: false, error: err.message, code: err.code }),
	);
	return true; // reply comes later
});
