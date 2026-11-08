// Email into the Import inbox: a scheduled check reads new messages (Ledger's
// Gmail account through ctx.gmail, or an IMAP mailbox for other providers) and
// saves the documents in bill-like emails (PDFs, statements, photos) as inbox
// files. With "save emails without attachments" on, such an email itself is
// saved as an .eml file. No AI here: the inbox's Send panel (Auto sort, Extract
// data, other modules) is where files are read, with a person approving.
//
// Based on the Auto sort module's mail check (lib/bill-routes.mjs there); the
// IMAP client and MIME parser (imap.mjs, mime.mjs) are the same files.

import { ImapClient } from "./imap.mjs";
import { parseEmail } from "./mime.mjs";

const MAX_MESSAGE_BYTES = 25 << 20;
const MAX_MESSAGES_PER_CHECK = 200;
const MAX_GMAIL_MESSAGES = 500;
/** Pictures smaller than this are logos and signatures, not photographed receipts. */
const MIN_IMAGE_BYTES = 20_000;
const MAX_IMAGES = 5;
const DOC_RE = /\.(pdf|csv|tsv|ofx|qfx|qbo|xlsx?|txt)$/i;
const DOC_TYPE_RE = /^(application\/(pdf|x-ofx|vnd\.intu\.qfx|x-qfx|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/(csv|tab-separated-values))\b/i;
const NAME_BAD = /[\u0000-\u001f/\\]/g;

const addresses = (s) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);

/** Mail you sent (Gmail's SENT without INBOX, a draft, or from you and not to you) isn't mail you received. */
export function sentByMe({ labels = null, from = "", to = "", cc = "" }, account = "") {
	if (labels && (labels.includes("DRAFT") || (labels.includes("SENT") && !labels.includes("INBOX")))) return true;
	const me = String(account ?? "").trim().toLowerCase();
	if (!me) return false;
	return addresses(from).has(me) && !addresses(`${to} ${cc}`).has(me);
}

/** Whether an email mentions a keyword (subject, sender, text, attachment names). No keywords: every email. */
export function looksLikeBill(email, keywords) {
	if (keywords.length === 0) return true;
	const hay = `${email.subject}\n${email.from}\n${email.text.slice(0, 20_000)}\n${email.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
	return keywords.some((k) => hay.includes(k.toLowerCase()));
}

export function gmailQuery({ lookbackDays, keywords, custom }) {
	const parts = [`newer_than:${lookbackDays}d`, "-in:drafts", "-in:chats"];
	if (custom) parts.push(custom);
	else if (keywords.length > 0) parts.push(`{${keywords.map((k) => (/\s/.test(k) ? `"${k.replace(/"/g, "")}"` : k)).join(" ")}}`);
	return parts.join(" ");
}

function imageType(b) {
	if (b.length < 12) return null;
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
	if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

/** The documents worth importing from an email: [{ name, type, data }]. */
export function emailDocuments(email, maxBytes) {
	const out = [];
	for (const a of email.attachments) {
		if (a.data.length === 0 || a.data.length > maxBytes) continue;
		const img = imageType(a.data);
		if (DOC_RE.test(a.filename) || DOC_TYPE_RE.test(a.contentType) || (a.data.subarray(0, 5).toString("latin1") === "%PDF-")) {
			const type = a.data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : a.contentType || "application/octet-stream";
			const ext = type === "application/pdf" ? "pdf" : "bin";
			out.push({ name: a.filename || `attachment.${ext}`, type, data: a.data });
		} else if (img && a.data.length >= MIN_IMAGE_BYTES && out.filter((d) => d.type.startsWith("image/")).length < MAX_IMAGES) {
			out.push({ name: a.filename || `photo.${EXT[img]}`, type: img, data: a.data });
		}
	}
	return out.map((d) => ({ ...d, name: d.name.replace(NAME_BAD, "-").trim().slice(-255) || "attachment" }));
}

/** h: { q, T, saveFile(name, type, data, opts), maxBytes(), syncNotice() } */
export function registerMail(ctx, h) {
	const { q, T } = h;

	async function mailSettings() {
		// Settings are per organization (Ledger 0.11.1). "auto" reads Ledger's Gmail in the main
		// books only, so another organization doesn't import the same mail again.
		const v = await ctx.settings.get();
		const setting = ["auto", "gmail", "imap", "off"].includes(v.mail_source) ? v.mail_source : "auto";
		const source = setting === "auto" ? ((await ctx.orgs.current()).id === 1 ? "gmail" : "off") : setting;
		const num = (x, d, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d);
		return {
			source,
			setting,
			gmail_query: String(v.gmail_query ?? "").trim(),
			keywords: String(v.mail_keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
			lookback_days: num(v.mail_lookback_days, 30, 1, 365),
			interval: num(v.mail_interval, 60, 0, 10080),
			save_body: v.mail_save_body !== false,
			imap_host: String(v.imap_host ?? "").trim(),
			imap_port: num(v.imap_port, 993, 1, 65535),
			imap_user: String(v.imap_user ?? "").trim(),
			imap_password: String(v.imap_password ?? ""),
			imap_folder: String(v.imap_folder ?? "").trim() || "INBOX",
		};
	}

	/** What's missing before mail can be read, or "". */
	async function missing(m) {
		if (m.source === "off") {
			return m.setting === "auto"
				? `email isn't read in this organization (outside the main books that's the default); an admin can choose Gmail or IMAP under Settings → ${ctx.name} here`
				: `reading email is turned off under Settings → ${ctx.name}`;
		}
		if (m.source === "gmail") {
			const g = await ctx.gmail.status();
			if (!g.connected) return "Gmail isn't connected; an admin can connect it under Settings → Gmail";
			if (!g.canRead) return `${ctx.name} isn't allowed to read mail; an admin can allow it under Settings → Gmail`;
			return "";
		}
		return !m.imap_host || !m.imap_user || !m.imap_password ? `IMAP isn't set up: fill in the server, user name and password under Settings → ${ctx.name}` : "";
	}

	async function getState() {
		const { rows } = await q(`SELECT value FROM ${T("state")} WHERE key = 'mail'`);
		return rows[0]?.value ?? {};
	}
	async function saveState(patch) {
		await q(
			`INSERT INTO ${T("state")} (key, value) VALUES ('mail', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${T("state")}.value || EXCLUDED.value, updated_at = now()`,
			[JSON.stringify(patch)],
		);
	}

	/** Implicit TLS, except for a mail bridge on this machine (e.g. Proton Bridge on 127.0.0.1:1143). */
	function clientFor(m) {
		const local = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(m.imap_host);
		return new ImapClient({ host: m.imap_host, port: m.imap_port, secure: !local || m.imap_port === 993, rejectUnauthorized: !local, timeoutMs: 60_000 });
	}

	/** { folder, uidvalidity, keys(), account(), fetch(key) -> Buffer | { tooLarge } | null, close(), abort() } */
	async function openMailbox(m, since) {
		if (m.source === "gmail") {
			const query = gmailQuery({ lookbackDays: m.lookback_days, keywords: m.keywords, custom: m.gmail_query });
			return {
				folder: "gmail",
				uidvalidity: 0,
				async keys() {
					const ids = [];
					let pageToken;
					do {
						const r = await ctx.gmail.search(query, { max: 100, pageToken });
						for (const msg of r.messages) {
							if (msg.date && Date.parse(msg.date) < since.getTime()) continue;
							if (sentByMe({ labels: msg.labels ?? [] })) continue;
							ids.push(msg.id);
						}
						pageToken = r.nextPageToken ?? undefined;
					} while (pageToken && ids.length < MAX_GMAIL_MESSAGES);
					return ids.reverse(); // oldest first
				},
				account: async () => (await ctx.gmail.status()).account,
				async fetch(id) {
					const raw = await ctx.gmail.raw(id);
					return raw.length > MAX_MESSAGE_BYTES ? { tooLarge: true } : raw;
				},
				async close() {},
				abort() {},
			};
		}
		const client = clientFor(m);
		await client.connect();
		try {
			await client.login(m.imap_user, m.imap_password);
			const { uidvalidity } = await client.examine(m.imap_folder);
			return {
				folder: m.imap_folder,
				uidvalidity,
				keys: async () => (await client.searchSince(since)).map(String),
				account: async () => m.imap_user,
				async fetch(uid) {
					const size = await client.size(uid);
					if (size !== null && size > MAX_MESSAGE_BYTES) return { tooLarge: true };
					return client.fetch(uid);
				},
				close: () => client.logout(),
				abort: () => client.close(),
			};
		} catch (err) {
			client.close();
			throw err;
		}
	}

	let checking = false;

	async function checkMail({ trigger = "schedule", by = "email" } = {}) {
		if (checking) return { skipped: "a check is already running" };
		checking = true;
		const started = new Date();
		const result = { looked_at: 0, files: 0, emails_saved: 0, no_document: 0, filtered: 0, sent: 0, too_large: 0, remaining: 0 };
		let box;
		try {
			const m = await mailSettings();
			const why = await missing(m);
			if (why) throw new Error(why);
			const maxBytes = await h.maxBytes();
			const since = new Date(Date.now() - m.lookback_days * 86_400_000);
			box = await openMailbox(m, since);
			const keys = await box.keys();
			const { rows: seen } = await q(`SELECT uid FROM ${T("mail_seen")} WHERE folder = $1 AND uidvalidity = $2 AND uid = ANY($3::text[])`, [box.folder, box.uidvalidity, keys]);
			const done = new Set(seen.map((r) => r.uid));
			const todo = keys.filter((k) => !done.has(k));
			const account = await box.account();
			result.remaining = Math.max(0, todo.length - MAX_MESSAGES_PER_CHECK);
			for (const uid of todo.slice(0, MAX_MESSAGES_PER_CHECK)) {
				const raw = await box.fetch(uid);
				if (!raw) continue;
				let outcome;
				let saved = 0;
				let subject = "";
				let from = "";
				if (raw.tooLarge) outcome = "too_large";
				else {
					const email = parseEmail(raw);
					subject = email.subject;
					from = email.from;
					if (sentByMe(email, account)) outcome = "sent";
					else if (!looksLikeBill(email, m.keywords)) outcome = "filtered";
					else {
						const note = `Email from ${from || "an unknown sender"}${subject ? `: "${subject}"` : ""}`.slice(0, 1000);
						const sender = (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] || [...addresses(from)][0] || "email").trim();
						const docs = emailDocuments(email, maxBytes);
						for (const d of docs) await h.saveFile(d.name, d.type, d.data, { origin: "email", detail: sender, note, by });
						saved = docs.length;
						if (saved > 0) outcome = "files";
						else if (m.save_body && raw.length <= maxBytes) {
							const name = `${(subject || "email").replace(NAME_BAD, "-").replace(/[<>:"|?*]/g, "").trim().slice(0, 200) || "email"}.eml`;
							await h.saveFile(name, "message/rfc822", raw, { origin: "email", detail: sender, note, by });
							saved = 1;
							outcome = "email_saved";
						} else outcome = "no_document";
					}
				}
				await q(
					`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, files, subject, mail_from) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
					[box.folder, box.uidvalidity, uid, outcome, saved, subject.slice(0, 300), from.slice(0, 300)],
				);
				result.looked_at++;
				if (outcome === "files") result.files += saved;
				else if (outcome === "email_saved") result.emails_saved++;
				else result[outcome]++;
			}
			await box.close();
			await saveState({ last_check_at: started.toISOString(), last_ok_at: new Date().toISOString(), error: null, result, trigger });
			await ctx.dashboard.remove("mail-error", "notification").catch(() => {});
			if (result.files + result.emails_saved > 0) await h.syncNotice();
			ctx.log.info("mail checked", { ...result, trigger });
			return result;
		} catch (err) {
			box?.abort();
			const error = String(err?.message || err).slice(0, 500);
			await saveState({ last_check_at: started.toISOString(), error, result, trigger }).catch(() => {});
			await ctx.dashboard.notify({ key: "mail-error", title: `${ctx.name} couldn't check email`, body: error, level: "danger", link: `/apps/${ctx.id}` }).catch(() => {});
			ctx.log.warn("mail check failed", { err: error, trigger });
			return { ...result, error };
		} finally {
			checking = false;
		}
	}

	// GET /mail: the email check, for the page.
	ctx.route("GET", "/mail", async () => {
		const m = await mailSettings();
		return { source: m.source, setting: m.setting, interval: m.interval, missing: await missing(m), checking, state: await getState() };
	});

	// POST /mail/check: check now.
	ctx.route("POST", "/mail/check", async (req) => {
		const m = await mailSettings();
		const why = await missing(m);
		if (why) throw new ctx.HttpError(409, why);
		return checkMail({ trigger: "manual", by: req.user.username });
	});

	// Every minute: is a check due? Timers run in the main books, so visit each organization.
	const timer = setInterval(async () => {
		try {
			await ctx.orgs.forEach(async () => {
				const m = await mailSettings();
				if (!(m.interval > 0) || checking || (await missing(m))) return;
				const last = Date.parse((await getState()).last_check_at ?? "") || 0;
				if (Date.now() - last >= m.interval * 60_000) await checkMail();
			});
		} catch (err) {
			ctx.log.error("mail scheduler", { err: String(err?.message || err) });
		}
	}, 60_000);
	timer.unref?.();

	return { checkMail };
}
