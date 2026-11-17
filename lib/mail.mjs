// Email into the Import inbox: a scheduled check reads new messages from the
// mailbox Ledger is connected to (ctx.mail: the IMAP/SMTP account under
// Settings → Mail, e.g. Proton Mail Bridge, or Gmail) and saves the documents
// in bill-like emails (PDFs, statements, photos) as inbox files. With "save
// emails without attachments" on, such an email itself is saved as an .eml
// file. No AI here: the inbox's Send panel is where files are read, with a
// person approving. No mail protocol here either: Ledger does that.

import { createHash } from "node:crypto";
import { features, learner } from "./learn.mjs";

const MAX_MESSAGES_PER_CHECK = 200;
const SEARCH_PAGE = 100; // ctx.mail.search returns at most 100, newest first
const MAX_SEARCH_PAGES = 10;
/** A date range import (Settings → Import → Email) may go further than a check. */
const MAX_RANGE_DAYS = 3660;
const MAX_RANGE_PAGES = 100;
const MAX_RANGE_MESSAGES = 5000;
/** Pictures smaller than this are logos and signatures, not photographed receipts. */
const MIN_IMAGE_BYTES = 20_000;
const MAX_IMAGES = 5;
const DOC_RE = /\.(pdf|csv|tsv|ofx|qfx|qbo|xlsx?|txt)$/i;
const DOC_TYPE_RE = /^(application\/(pdf|x-ofx|vnd\.intu\.qfx|x-qfx|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/(csv|tab-separated-values))\b/i;
const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;
const IMAGE_TYPE_RE = /^image\/(jpeg|png|gif|webp)\b/i;
const NAME_BAD = /[\u0000-\u001f/\\]/g;

const addresses = (s) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);

/** Mail you sent (from you and not to you) isn't mail you received. */
export function sentByMe({ from = "", to = "", cc = "" }, account = "") {
	const me = String(account ?? "").trim().toLowerCase();
	if (!me) return false;
	return addresses(from).has(me) && !addresses(`${to} ${cc}`).has(me);
}

/** Whether an email mentions a keyword (subject, sender, text, attachment names). No keywords: every email. */
export function looksLikeBill(email, keywords) {
	if (keywords.length === 0) return true;
	const hay = `${email.subject}\n${email.from}\n${String(email.text ?? "").slice(0, 20_000)}\n${email.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
	return keywords.some((k) => hay.includes(k.toLowerCase()));
}

export function htmlToText(html) {
	return String(html ?? "")
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

const emlName = (subject) => `${(subject || "email").replace(NAME_BAD, "-").replace(/[<>:"|?*]/g, "").trim().slice(0, 200) || "email"}.eml`;

/**
 * The attachments worth importing, from their names, types and sizes (before any is downloaded):
 * [{ attachmentId, name, type }]. Documents (PDF, CSV, OFX, spreadsheets), and up to 5 pictures big
 * enough to be a photographed receipt, not a logo.
 */
export function emailCandidates(attachments, maxBytes) {
	const out = [];
	let images = 0;
	for (const a of attachments ?? []) {
		const filename = String(a.filename ?? "");
		const type = String(a.mimeType ?? "").split(";")[0].trim().toLowerCase();
		const size = Number(a.size) || 0;
		if (size > maxBytes) continue;
		let name = filename;
		if (DOC_RE.test(filename) || DOC_TYPE_RE.test(type)) name ||= type === "application/pdf" ? "attachment.pdf" : "attachment";
		else if (IMAGE_RE.test(filename) || IMAGE_TYPE_RE.test(type)) {
			if (size < MIN_IMAGE_BYTES || images >= MAX_IMAGES) continue;
			images++;
			name ||= `photo.${type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1] || "jpg"}`;
		} else continue;
		out.push({ attachmentId: a.attachmentId, name: name.replace(NAME_BAD, "-").trim().slice(-255) || "attachment", type: type || "application/octet-stream" });
	}
	return out;
}

const gone = (err) => err?.status === 404 || err?.constructor?.name === "NotFoundError";
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** h: { q, T, saveFile(name, type, data, opts), maxBytes(), syncNotice(), learnKept(fileIds, source, by) } */
export function registerMail(ctx, h) {
	const { q, T } = h;

	async function mailSettings() {
		// Settings are per organization (Ledger 0.11.1). "auto" reads the mailbox in the main books
		// only, so another organization doesn't import the same mail again.
		const v = await ctx.settings.get();
		// "gmail" and "imap" are choices from before Ledger had one mailbox for every module.
		const setting = ["gmail", "imap", "mail"].includes(v.mail_source) ? "mail" : v.mail_source === "off" ? "off" : "auto";
		const source = setting === "auto" ? ((await ctx.orgs.current()).id === 1 ? "mail" : "off") : setting;
		const num = (x, d, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d);
		return {
			source,
			setting,
			keywords: String(v.mail_keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
			lookback_days: num(v.mail_lookback_days, 30, 1, 365),
			interval: num(v.mail_interval, 60, 0, 10080),
			save_body: v.mail_save_body !== false,
		};
	}

	/** What's missing before mail can be read, or "". */
	async function missing(m, st = null) {
		if (m.source === "off") {
			return m.setting === "auto"
				? `email isn't read in this organization (outside the main books that's the default); an admin can turn it on under Settings → ${ctx.name} here`
				: `reading email is turned off under Settings → ${ctx.name}`;
		}
		st ??= await ctx.mail.status();
		if (!st.connected) return "no mailbox is connected; an admin can connect one under Settings → Mail";
		if (!st.canRead) return `${ctx.name} isn't allowed to read mail; an admin can allow it under Settings → Mail`;
		return "";
	}

	async function getState() {
		const { rows } = await q(`SELECT value FROM ${T("email_check_state")} WHERE key = 'mail'`);
		return rows[0]?.value ?? {};
	}
	async function saveState(patch) {
		await q(
			`INSERT INTO ${T("email_check_state")} (key, value) VALUES ('mail', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${T("email_check_state")}.value || EXCLUDED.value, updated_at = now()`,
			[JSON.stringify(patch)],
		);
	}

	/** Which mailbox the ids belong to: ids from one mailbox mean nothing in another. */
	const folderOf = (st) => `${st.kind}:${String(st.account ?? "").toLowerCase()}`.slice(0, 200);

	/**
	 * Ids of the messages from a date (and before another, by day, if given), oldest first. The
	 * search gives 100 at a time, newest first, so walk back by date.
	 */
	async function messagesSince(since, { before: until = null, pages = MAX_SEARCH_PAGES } = {}) {
		const seen = new Map(); // id -> date
		let before = until ? day(until) : undefined;
		for (let page = 0; page < pages; page++) {
			const { messages } = await ctx.mail.search({ since: day(since), ...(before ? { before } : {}), max: SEARCH_PAGE });
			let fresh = 0;
			let oldest = null;
			for (const m of messages) {
				const t = Date.parse(m.date) || 0;
				if (oldest === null || (t && t < oldest)) oldest = t;
				if (!seen.has(m.id)) {
					seen.set(m.id, t);
					fresh++;
				}
			}
			if (messages.length < SEARCH_PAGE || fresh === 0 || !oldest) break;
			before = day(oldest + 86_400_000); // "before" is by day: ask again up to and including the oldest day seen
		}
		return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
	}

	const senderName = (from) => (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] || [...addresses(from)][0] || "email").trim();
	const noteFor = (email) => `Email from ${email.from || "an unknown sender"}${email.subject ? `: "${email.subject}"` : ""}`.slice(0, 1000);
	const asEmail = (m) => ({ subject: m.subject ?? "", from: m.from ?? "", to: m.to ?? "", cc: m.cc ?? "", text: m.text || htmlToText(m.html), attachments: m.attachments ?? [] });

	let checking = false;

	/** Whether a file with these bytes is in the inbox already (sent, archived or waiting). */
	async function haveBytes(data) {
		const sha = createHash("sha256").update(data).digest("hex");
		const { rows } = await q(`SELECT id FROM ${T("files")} WHERE sha256 = $1 LIMIT 1`, [sha]);
		return rows.length > 0;
	}

	/** Reads one message and saves its documents as inbox files → { outcome, saved, duplicates, reason, email }. */
	async function importMessage(id, { m, st, maxBytes, learned, by, user }) {
		let outcome;
		let saved = 0;
		let duplicates = 0;
		let reason = "";
		let email = { subject: "", from: "" };
		let msg = null;
		try {
			msg = await ctx.mail.message(id);
		} catch (err) {
			if (!gone(err)) throw err;
			return { outcome: "gone", saved, duplicates, reason, email }; // moved or deleted since the search
		}
		email = asEmail(msg);
		if (sentByMe(email, st.account)) return { outcome: "sent", saved, duplicates, reason, email };
		if (!looksLikeBill(email, m.keywords)) return { outcome: "filtered", saved, duplicates, reason, email };
		const opts = { origin: "email", detail: senderName(email.from), note: noteFor(email), by, user };
		const save = async (name, type, data, feats) => {
			if (await haveBytes(data)) duplicates++; // the same file came before (another email, the browser, …)
			else {
				await h.saveFile(name, type, data, { ...opts, features: feats });
				saved++;
			}
		};
		const candidates = emailCandidates(email.attachments, maxBytes);
		const skipped = [];
		for (const c of candidates) {
			const feats = features(email, c);
			const j = learned.judge(feats);
			if (j.skip) {
				skipped.push(`${c.name}: ${j.reason}`);
				continue;
			}
			const data = await ctx.mail.attachment(id, c.attachmentId);
			if (!data?.length || data.length > maxBytes) continue;
			await save(c.name, data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : c.type, data, feats);
		}
		reason = skipped.join("; ").slice(0, 2000);
		if (saved > 0) outcome = "files";
		else if (duplicates > 0) outcome = "duplicate";
		else if (candidates.length > 0) outcome = skipped.length ? "learned_skip" : "no_document";
		else if (m.save_body) {
			const feats = features(email, null);
			const j = learned.judge(feats);
			if (j.skip) {
				outcome = "learned_skip";
				reason = j.reason;
			} else {
				const raw = await ctx.mail.raw(id);
				if (raw.length > maxBytes) outcome = "no_document";
				else {
					await save(emlName(email.subject), "message/rfc822", raw, feats);
					outcome = saved ? "email_saved" : "duplicate";
				}
			}
		} else outcome = "no_document";
		return { outcome, saved, duplicates, reason, email, skipped: skipped.length };
	}

	const emptyResult = () => ({ looked_at: 0, files: 0, emails_saved: 0, no_document: 0, filtered: 0, learned_skip: 0, files_skipped: 0, duplicates: 0, already_seen: 0, sent: 0, gone: 0, remaining: 0 });

	/**
	 * Imports the messages from `since` (to before `before`, by day) that this mailbox hasn't
	 * given before; each message once (mail_seen), each file's bytes once (the inbox's sha256).
	 */
	async function importRange({ since, before = null, limit, pages, by, user, onProgress = () => {} }) {
		const result = emptyResult();
		const m = await mailSettings();
		const st = await ctx.mail.status();
		const why = await missing(m, st);
		if (why) throw new Error(why);
		const maxBytes = await h.maxBytes();
		const folder = folderOf(st);
		const ids = await messagesSince(since, { before, pages });
		const { rows: seen } = await q(`SELECT uid FROM ${T("mail_seen")} WHERE folder = $1 AND uidvalidity = 0 AND uid = ANY($2::text[])`, [folder, ids]);
		const done = new Set(seen.map((r) => r.uid));
		const todo = ids.filter((k) => !done.has(k));
		result.already_seen = ids.length - todo.length;
		// What you taught it: deleted ("unwanted") and sent-on ("wanted") email files.
		const learned = learner((await q(`SELECT label, features FROM ${T("mail_training")} ORDER BY id DESC LIMIT 5000`)).rows);
		result.remaining = Math.max(0, todo.length - limit);
		const batch = todo.slice(0, limit);
		onProgress(0, batch.length, result);
		for (const id of batch) {
			const r = await importMessage(id, { m, st, maxBytes, learned, by, user });
			await q(
				`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, files, subject, mail_from, reason) VALUES ($1, 0, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
				[folder, id, r.outcome, r.saved, r.email.subject.slice(0, 300), r.email.from.slice(0, 300), r.reason],
			);
			result.looked_at++;
			result.files_skipped += r.skipped ?? 0;
			result.duplicates += r.duplicates;
			if (r.outcome === "files") result.files += r.saved;
			else if (r.outcome === "email_saved") result.emails_saved++;
			else if (r.outcome !== "duplicate") result[r.outcome]++;
			onProgress(result.looked_at, batch.length, result);
		}
		if (result.files + result.emails_saved > 0) await h.syncNotice();
		return { result, mailbox: st.kind };
	}

	async function checkMail({ trigger = "schedule", by = "email", user } = {}) {
		if (checking) return { skipped: "a check is already running" };
		checking = true;
		const started = new Date();
		let result = emptyResult();
		try {
			const m = await mailSettings();
			const out = await importRange({ since: new Date(Date.now() - m.lookback_days * 86_400_000), limit: MAX_MESSAGES_PER_CHECK, by, user, onProgress: (_, __, r) => (result = r) });
			result = out.result;
			await saveState({ last_check_at: started.toISOString(), last_ok_at: new Date().toISOString(), error: null, result, trigger, mailbox: out.mailbox });
			await ctx.dashboard.remove("mail-error", "notification").catch(() => {});
			ctx.log.info("mail checked", { ...result, trigger });
			return result;
		} catch (err) {
			const error = String(err?.message || err).slice(0, 500);
			await saveState({ last_check_at: started.toISOString(), error, result, trigger }).catch(() => {});
			await ctx.dashboard.notify({ key: "mail-error", title: `${ctx.name} couldn't check email`, body: error, level: "danger", link: `/apps/${ctx.id}` }).catch(() => {});
			ctx.log.warn("mail check failed", { err: error, trigger });
			return { ...result, error };
		} finally {
			checking = false;
		}
	}

	// ---------------------------------------------------------------------
	// Importing a date range (Settings → Import → Email): in the background,
	// in the request's organization; the page polls GET /mail/range.
	// ---------------------------------------------------------------------

	const rangeJobs = new Map(); // organization id -> the last range import there (in memory)
	const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	const validDate = (s) => typeof s === "string" && DATE_RE.test(s) && day(`${s}T00:00:00Z`) === s;

	async function startRange({ from, to }, user) {
		if (!validDate(from) || !validDate(to)) throw new ctx.HttpError(422, "give from and to as dates (YYYY-MM-DD)");
		if (from > to) throw new ctx.HttpError(422, "the range starts after it ends");
		const today = day(Date.now());
		if (from > today) throw new ctx.HttpError(422, "the range starts in the future");
		if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) throw new ctx.HttpError(422, `a range can be at most ${MAX_RANGE_DAYS} days; import a longer time in parts`);
		const m = await mailSettings();
		const why = await missing(m);
		if (why) throw new ctx.HttpError(409, why);
		if (checking) throw new ctx.HttpError(409, "email is being checked right now; try again in a minute");
		const org = (await ctx.orgs.current()).id;
		const job = { status: "running", from, to, done: 0, total: 0, result: emptyResult(), error: null, by: user.username, started_at: new Date().toISOString(), finished_at: null };
		rangeJobs.set(org, job);
		checking = true;
		// Not awaited: runs on in the background, in this request's organization.
		(async () => {
			try {
				const out = await importRange({
					since: `${from}T00:00:00Z`,
					before: Date.parse(`${to}T00:00:00Z`) + 86_400_000, // "to" is included
					limit: MAX_RANGE_MESSAGES,
					pages: MAX_RANGE_PAGES,
					by: user.username,
					user,
					onProgress: (done, total, r) => Object.assign(job, { done, total, result: r }),
				});
				job.result = out.result;
				job.status = "done";
				ctx.log.info("mail range imported", { from, to, ...out.result, by: user.username });
			} catch (err) {
				job.status = "error";
				job.error = String(err?.message || err).slice(0, 500);
				ctx.log.warn("mail range import failed", { from, to, err: job.error });
			} finally {
				job.finished_at = new Date().toISOString();
				checking = false;
			}
		})();
		return job;
	}

	// POST /mail/range {from, to}: import the email of those days (both included), leaving out what's already here.
	ctx.route("POST", "/mail/range", async (req) => {
		const b = req.body ?? {};
		return ctx.response(202, await startRange({ from: b.from, to: b.to }, req.user));
	});

	// GET /mail/range: the last range import in this organization, or null.
	ctx.route("GET", "/mail/range", async () => {
		const m = await mailSettings();
		const st = m.source === "off" ? null : await ctx.mail.status().catch(() => null);
		return { job: rangeJobs.get((await ctx.orgs.current()).id) ?? null, missing: await missing(m, st ?? undefined), mailbox: st?.kind ?? null, account: st?.account ?? null, checking };
	});

	/**
	 * Imports one message the check skipped (or partly skipped), ignoring what it learned, and
	 * teaches it that such files are wanted. Files already in the inbox (same bytes) aren't added twice.
	 */
	async function importSkipped({ folder, uid }, user) {
		const by = user.username;
		const { rows } = await q(`SELECT outcome, reason FROM ${T("mail_seen")} WHERE folder = $1 AND uid = $2`, [folder, uid]);
		if (!rows[0] || !rows[0].reason) throw new ctx.HttpError(404, "no such skipped email");
		const m = await mailSettings();
		const st = await ctx.mail.status();
		const why = await missing(m, st);
		if (why) throw new ctx.HttpError(409, why);
		if (folderOf(st) !== folder) throw new ctx.HttpError(409, "this email was skipped in another mailbox than the one Ledger is connected to now; it can't be fetched again");
		let msg;
		try {
			msg = await ctx.mail.message(uid);
		} catch (err) {
			if (gone(err)) throw new ctx.HttpError(404, "the email isn't in the mailbox any more (or the mailbox was rebuilt since)");
			throw err;
		}
		const email = asEmail(msg);
		const opts = { origin: "email", detail: senderName(email.from), note: noteFor(email), by, user };
		const maxBytes = await h.maxBytes();
		const docs = [];
		for (const c of emailCandidates(email.attachments, maxBytes)) {
			const data = await ctx.mail.attachment(uid, c.attachmentId);
			if (data?.length && data.length <= maxBytes) docs.push({ name: c.name, type: c.type, data, feats: features(email, c) });
		}
		if (docs.length === 0) {
			const raw = await ctx.mail.raw(uid);
			if (raw.length <= maxBytes) docs.push({ name: emlName(email.subject), type: "message/rfc822", data: raw, feats: features(email, null) });
		}
		const ids = [];
		for (const d of docs) {
			if (await haveBytes(d.data)) continue;
			ids.push(await h.saveFile(d.name, d.type, d.data, { ...opts, features: d.feats }));
		}
		await q(`UPDATE ${T("mail_seen")} SET outcome = $3, files = files + $4, reason = '' WHERE folder = $1 AND uid = $2`, [folder, uid, ids.length ? "files" : rows[0].outcome, ids.length]);
		await h.learnKept(ids, "import", by);
		await h.syncNotice();
		return { files: ids.length, file_ids: ids };
	}

	// GET /mail/skipped: emails (or some of their files) the check skipped because of what it learned.
	ctx.route("GET", "/mail/skipped", async () => {
		const { rows } = await q(
			`SELECT folder, uid, outcome, files, subject, mail_from, reason, seen_at FROM ${T("mail_seen")}
			  WHERE reason <> '' AND seen_at > now() - interval '90 days' ORDER BY seen_at DESC LIMIT 100`,
		);
		return { data: rows };
	});

	// POST /mail/skipped/import {folder, uid}: import it anyway.
	ctx.route("POST", "/mail/skipped/import", async (req) => {
		const b = req.body ?? {};
		if (typeof b.folder !== "string" || !b.folder || b.folder.length > 300 || typeof b.uid !== "string" || !b.uid || b.uid.length > 300) {
			throw new ctx.HttpError(422, "give folder and uid of a skipped email (from GET /mail/skipped)");
		}
		return importSkipped({ folder: b.folder, uid: b.uid }, req.user);
	});

	// GET /mail: the email check, for the page.
	ctx.route("GET", "/mail", async () => {
		const m = await mailSettings();
		const st = m.source === "off" ? null : await ctx.mail.status().catch(() => null);
		return { source: m.source, setting: m.setting, interval: m.interval, mailbox: st?.kind ?? null, account: st?.account ?? null, missing: await missing(m, st ?? undefined), checking, state: await getState() };
	});

	// POST /mail/check: check now.
	ctx.route("POST", "/mail/check", async (req) => {
		const m = await mailSettings();
		const why = await missing(m);
		if (why) throw new ctx.HttpError(409, why);
		return checkMail({ trigger: "manual", by: req.user.username, user: req.user });
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

	return { checkMail, importRange };
}
