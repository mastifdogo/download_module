// Import (module id "downloads", kept so installs and data carry over): an inbox
// in Ledger for files from the browser (the Send to Ledger extension in
// ui/extension/), from email (lib/mail.mjs), from a network scanner
// (lib/escl.mjs), from a phone's camera or uploaded on the page. Ledger loads
// this file at startup and calls register(ctx); API: docs/MODULE_LLM_CONTEXT.md
// in the Ledger repository.
//
// Upload (the extension does this from a Ledger tab, with the user's login):
//   POST /files {name, content_type, size, source_url?}  -> {id, chunk_size}
//   PUT  /files/:id/chunks/:index {data: base64}         (each chunk <= chunk_size bytes)
//   POST /files/:id/complete                              -> the file
// Chunks keep each request under Ledger's 1 MiB JSON limit.

import { createHash, randomUUID } from "node:crypto";
import { capabilities, findScanners, normalizeScannerUrl, scan, ScannerError, status as scannerStatus } from "./lib/escl.mjs";
import { registerMail } from "./lib/mail.mjs";
import { jpegsToPdf } from "./lib/pdf.mjs";

const CHUNK_SIZE = 512 * 1024; // bytes; base64 makes it ~700 KB, under Ledger's 1 MiB body limit
const STALE_UPLOAD_HOURS = 24;
const NAME_RE = /^[^\u0000-\u001f/\\]{1,255}$/;
const FILE_COLUMNS = `id, name, content_type, size_bytes, sha256, status, source_url, note, received_by, received_at,
	sent_to, sent_link, sent_by, sent_at, sent_file_id, origin, origin_detail, updated_at`;
const CLIENT_ORIGINS = ["", "camera", "upload"]; // what the page and the extension may say; email and scanner are set here
const FILE_KINDS = ["statement", "bill", "receipt", "transaction"]; // what ctx.files carries (Ledger >= 0.11.0)
const ACCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

// ---------------------------------------------------------------------------
// Extracting data with the AI (POST /files/:id/extract)
// ---------------------------------------------------------------------------

const EXTRACT_MAX_BYTES = 30 * 1024 * 1024; // Claude reads PDFs up to 32 MB
const EXTRACT_MAX_CHARS = 400_000; // ~100k tokens of text
const TEXT_EXT_RE = /\.(txt|text|ofx|qfx|qbo|html?|xml|json|tsv|eml|md|prn)$/i;
const TEXT_TYPE_RE = /^(text\/|application\/(json|xml|xhtml\+xml|x-ofx|vnd\.intu\.qfx|x-qfx)\b|message\/rfc822)/i;

const EXTRACT_SYSTEM = `You extract financial transactions from bank statements, credit card statements, account activity exports, receipts and invoices so they can be imported into bookkeeping software.
Rules:
- One entry per transaction, in the order they appear. Skip opening/closing balance lines, subtotals, headers and page footers.
- date: the transaction (or posting) date as YYYY-MM-DD. Infer the year from the statement period when rows omit it.
- description: the payee or description as printed, on one line.
- amount: a plain decimal number with a dot and no thousands separators or currency symbol, e.g. "-42.10". Negative is money leaving the account (purchases, withdrawals, fees, payments made); positive is money coming in (deposits, refunds, credits). For a credit card statement, purchases are negative and payments to the card are positive.
- balance: the running balance after the transaction in the same format, or "" when the document doesn't show one.
- currency: the ISO 4217 code of the amounts (e.g. "CAD", "USD"), or "" if unknown.
- A receipt or invoice is one transaction: its total, negative, dated the purchase date, with the vendor as description.
- Never invent transactions. If there are none, return an empty list.`;

const EXTRACT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["currency", "transactions"],
	properties: {
		currency: { type: "string" },
		transactions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["date", "description", "amount", "balance"],
				properties: {
					date: { type: "string" },
					description: { type: "string" },
					amount: { type: "string" },
					balance: { type: "string" },
				},
			},
		},
	},
};

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // per picture, what LLM APIs take
const IMAGE_MAX_COUNT = 20; // ctx.llm takes at most 20 images per request

/** "csv", "pdf", "image", "text", or null when the file can't be read. */
function extractKind(f) {
	const type = String(f.content_type || "").toLowerCase();
	if (/\.csv$/i.test(f.name) || /^text\/csv\b/.test(type)) return "csv";
	if (/\.pdf$/i.test(f.name) || /^application\/pdf\b/.test(type)) return "pdf";
	if (IMAGE_EXT_RE.test(f.name) || /^image\/(jpeg|png|gif|webp)\b/.test(type)) return "image";
	if (TEXT_EXT_RE.test(f.name) || TEXT_TYPE_RE.test(type)) return "text";
	return null;
}

/** The picture's media type from its first bytes (what ctx.llm accepts), or null. */
function imageType(b) {
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
	if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

/**
 * The JPEG photos inside a PDF (DCTDecode image streams): a scanned receipt, such as the
 * Scan receipt tab makes, as pictures for an image model that can't read PDFs.
 */
function pdfJpegs(bytes) {
	const text = bytes.toString("latin1"); // 1 char = 1 byte, so offsets match
	const out = [];
	const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;
	let m;
	while ((m = re.exec(text)) && out.length <= IMAGE_MAX_COUNT) {
		const dict = m[1];
		if (!/\/Subtype\s*\/Image\b/.test(dict) || !/\/DCTDecode\b/.test(dict) || /\/Filter\s*\[[^\]]*\/\w+[^\]]*\/\w+/.test(dict)) continue;
		const start = m.index + m[0].length;
		const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
		const end = direct ? start + Number(direct[1]) : text.indexOf("endstream", start);
		if (end <= start || end > bytes.length) continue;
		const jpeg = bytes.subarray(start, end);
		if (imageType(jpeg) === "image/jpeg") out.push(jpeg);
		re.lastIndex = end;
	}
	return out;
}

/** The file as text for the AI (HTML reduced to its text), or null if it's binary. */
function readableText(bytes, name) {
	if (bytes.includes(0)) return null;
	let text = new TextDecoder("utf-8").decode(bytes);
	if ((text.match(/�/g) || []).length > text.length / 100) text = bytes.toString("latin1"); // not UTF-8: Windows-1252 statements
	text = text.replace(/^﻿/, "");
	if (/\.html?$/i.test(name) || /^\s*<(!doctype html|html)\b/i.test(text)) {
		text = text
			.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<\/(tr|p|div|li|h\d|table)\s*>|<br\s*\/?>/gi, "\n")
			.replace(/<\/t[dh]\s*>/gi, "\t")
			.replace(/<[^>]*>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
			.replace(/[ \t]*\n\s*/g, "\n")
			.replace(/[  ]{2,}/g, " ");
	}
	return text;
}

/** "1,234.5" / "(12.00)" / "$-3" -> "1234.50" / "-12.00" / "-3.00", or null. Exact: no floats. */
function decimal(s) {
	let t = String(s ?? "").replace(/[\s,$€£¥]|[A-Z]{3}/g, "");
	let neg = false;
	const paren = /^\((.*)\)$/.exec(t);
	if (paren) [neg, t] = [true, paren[1]];
	if (t.endsWith("-")) [neg, t] = [true, t.slice(0, -1)]; // "12.00-"
	const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
	if (!m) return null;
	if (m[1] === "-") neg = !neg;
	const whole = m[2].replace(/^0+(?=\d)/, "");
	const cents = (m[3] ?? "").padEnd(2, "0");
	const zero = /^0+$/.test(whole) && cents === "00";
	return `${neg && !zero ? "-" : ""}${whole}.${cents}`;
}

/** The AI's rows, checked: valid dates and amounts only. */
function cleanTransactions(data) {
	const list = Array.isArray(data?.transactions) ? data.transactions : [];
	const out = [];
	for (const t of list) {
		const date = String(t?.date ?? "").trim();
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
		if (!m) continue;
		const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
		if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) continue;
		const amount = decimal(t?.amount);
		if (amount === null) continue;
		const description = String(t?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
		const balance = t?.balance === "" || t?.balance == null ? "" : (decimal(t.balance) ?? "");
		out.push({ date, description, amount, balance });
	}
	return out;
}

/** Rows a person edited before approving: every row must be valid (422 names the first bad one). */
function checkRows(list) {
	if (!Array.isArray(list) || list.length > 5000) throw new Error("rows must be a list of at most 5000 transactions");
	const ok = cleanTransactions({ transactions: list });
	if (ok.length !== list.length) {
		const i = list.findIndex((t) => cleanTransactions({ transactions: [t] }).length === 0);
		throw new Error(`row ${i + 1}: needs a real date (YYYY-MM-DD) and an amount such as -42.10`);
	}
	return ok;
}

/** Date,Description,Amount[,Balance] with quoting, and text cells guarded against spreadsheet formulas. */
function toCsv(tx) {
	const withBalance = tx.some((t) => t.balance !== "");
	const cell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
	const text = (s) => cell(s !== "" && "=+-@\t\r".includes(s[0]) ? "'" + s : s);
	const lines = [withBalance ? "Date,Description,Amount,Balance" : "Date,Description,Amount"];
	for (const t of tx) lines.push([t.date, text(t.description), t.amount, ...(withBalance ? [t.balance] : [])].join(","));
	return lines.join("\r\n") + "\r\n";
}

/** "May statement (1).pdf" -> "May-statement-1-extracted.csv": a name Ledger's CSV files accept. */
function csvName(name) {
	const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[-.]+$/g, "").slice(0, 100);
	return `${base || "file"}-extracted.csv`;
}

/** @param {any} ctx */
export default async function register(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (msg) => new ctx.HttpError(422, msg);
	const notFound = () => new ctx.HttpError(404, "no such file");

	async function options() {
		const v = await ctx.settings.get();
		const n = (x, d, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d);
		return { maxBytes: n(v.max_file_mb, 25, 1, 100) * 1024 * 1024, keepDays: n(v.keep_days, 0, 0, 3650) };
	}

	async function getFile(id) {
		if (!/^\d+$/.test(String(id))) throw notFound();
		const { rows } = await q(`SELECT ${FILE_COLUMNS} FROM ${T("files")} WHERE id = $1`, [id]);
		if (!rows[0]) throw notFound();
		return rows[0];
	}

	/** Stores a whole file (from email or the scanner) in the inbox in one statement → its id. */
	async function saveFile(name, type, data, { origin = "", detail = "", note = "", source_url = "", by }) {
		const chunks = [];
		for (let i = 0; i < data.length; i += CHUNK_SIZE) chunks.push(data.subarray(i, i + CHUNK_SIZE));
		const { rows } = await q(
			`WITH f AS (
				INSERT INTO ${T("files")} (name, content_type, size_bytes, sha256, status, source_url, note, received_by, origin, origin_detail)
				VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9) RETURNING id
			), c AS (
				INSERT INTO ${T("file_chunks")} (file_id, idx, data)
				SELECT f.id, (u.n - 1)::int, u.data FROM f, unnest($10::bytea[]) WITH ORDINALITY AS u(data, n)
			)
			SELECT id FROM f`,
			[name.slice(0, 255), String(type).slice(0, 200), data.length, createHash("sha256").update(data).digest("hex"), source_url, note.slice(0, 1000), by, origin, detail.slice(0, 200), chunks],
		);
		ctx.log.info("file received", { file: String(rows[0].id), name, bytes: data.length, origin, by });
		return rows[0].id;
	}

	// ---------------------------------------------------------------------
	// Dashboard: one notification while files wait in the inbox
	// ---------------------------------------------------------------------

	async function syncNotice() {
		try {
			const { rows } = await q(`SELECT name FROM ${T("files")} WHERE status = 'new' ORDER BY received_at DESC`);
			const n = rows.length;
			if (n === 0) await ctx.dashboard.remove("inbox", "notification");
			else await ctx.dashboard.notify({
				key: "inbox",
				title: `${n} file${n === 1 ? "" : "s"} waiting in ${ctx.name}`,
				body: rows.slice(0, 3).map((r) => r.name).join(", ") + (n > 3 ? ", …" : ""),
				level: "info",
				link: `/apps/${ctx.id}`,
			});
			await syncReviewTodo();
		} catch (err) {
			ctx.log.warn("dashboard update failed", { err: String(err?.message || err) });
		}
	}

	// A to-do while AI suggestions wait for a person to check them.
	async function syncReviewTodo() {
		const { rows } = await q(`SELECT f.name FROM ${T("extractions")} e JOIN ${T("files")} f ON f.id = e.file_id WHERE e.status = 'pending' ORDER BY e.id`);
		if (rows.length === 0) return void (await ctx.dashboard.remove("review"));
		const n = rows.length;
		await ctx.dashboard.todo({
			key: "review",
			title: `Check ${n} AI extraction${n === 1 ? "" : "s"} in ${ctx.name}`,
			body: rows.slice(0, 3).map((r) => r.name).join(", ") + (n > 3 ? ", …" : ""),
			link: `/apps/${ctx.id}`,
		});
	}

	// ---------------------------------------------------------------------
	// Upload
	// ---------------------------------------------------------------------

	ctx.route("POST", "/files", async (req) => {
		const b = req.body ?? {};
		const name = typeof b.name === "string" ? b.name.trim() : "";
		if (!NAME_RE.test(name)) throw bad("name must be a file name of 1-255 characters");
		const size = Number(b.size);
		const { maxBytes } = await options();
		if (!Number.isSafeInteger(size) || size < 1) throw bad("size must be the file's size in bytes");
		if (size > maxBytes) throw new ctx.HttpError(413, `the file is larger than ${maxBytes / 1024 / 1024} MB (the limit is under Settings → ${ctx.name})`);
		const type = typeof b.content_type === "string" ? b.content_type.slice(0, 200) : "";
		let source = typeof b.source_url === "string" ? b.source_url.trim() : "";
		if (source && !/^https?:\/\/\S{1,2000}$/.test(source)) source = "";
		const origin = b.origin === undefined ? "" : b.origin;
		if (!CLIENT_ORIGINS.includes(origin)) throw bad('origin must be "camera" or "upload" (or left out)');
		const { rows } = await q(
			`INSERT INTO ${T("files")} (name, content_type, size_bytes, source_url, received_by, origin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			[name, type, size, source, req.user.username, origin],
		);
		return ctx.response(201, { id: rows[0].id, chunk_size: CHUNK_SIZE, chunks: Math.ceil(size / CHUNK_SIZE) });
	});

	ctx.route("PUT", "/files/:id/chunks/:index", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status !== "uploading") throw new ctx.HttpError(409, "this file is already complete");
		if (!/^\d+$/.test(req.params.index)) throw bad("index must be a number");
		const index = Number(req.params.index);
		const chunks = Math.ceil(Number(f.size_bytes) / CHUNK_SIZE);
		if (index >= chunks) throw bad(`index must be below ${chunks}`);
		const b64 = req.body?.data;
		if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad("data must be base64");
		const data = Buffer.from(b64, "base64");
		const expected = index === chunks - 1 ? Number(f.size_bytes) - index * CHUNK_SIZE : CHUNK_SIZE;
		if (data.length !== expected) throw bad(`chunk ${index} must be ${expected} bytes, got ${data.length}`);
		await q(
			`INSERT INTO ${T("file_chunks")} (file_id, idx, data) VALUES ($1, $2, $3) ON CONFLICT (file_id, idx) DO UPDATE SET data = EXCLUDED.data`,
			[f.id, index, data],
		);
	});

	ctx.route("POST", "/files/:id/complete", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status !== "uploading") return f;
		const { rows } = await q(`SELECT idx, data FROM ${T("file_chunks")} WHERE file_id = $1 ORDER BY idx`, [f.id]);
		const chunks = Math.ceil(Number(f.size_bytes) / CHUNK_SIZE);
		const missing = [];
		for (let i = 0; i < chunks; i++) if (rows[i]?.idx !== i) missing.push(i);
		if (missing.length > 0) throw new ctx.HttpError(409, `chunks missing: ${missing.slice(0, 10).join(", ")}`);
		const hash = createHash("sha256");
		for (const r of rows) hash.update(r.data);
		const sha = hash.digest("hex");
		const { rows: dup } = await q(`SELECT id, name, status FROM ${T("files")} WHERE sha256 = $1 AND id <> $2 ORDER BY id DESC LIMIT 1`, [sha, f.id]);
		await q(`UPDATE ${T("files")} SET status = 'new', sha256 = $2, updated_at = now() WHERE id = $1`, [f.id, sha]);
		ctx.log.info("file received", { file: String(f.id), name: f.name, bytes: Number(f.size_bytes), by: req.user.username });
		await syncNotice();
		return { ...(await getFile(f.id)), duplicate_of: dup[0] ?? null };
	});

	// ---------------------------------------------------------------------
	// Inbox
	// ---------------------------------------------------------------------

	ctx.route("GET", "/files", async (req) => {
		const status = req.query.get("status") || "new";
		if (!["new", "sent", "archived", "all"].includes(status)) throw bad("status must be new, sent, archived or all");
		const { rows } = await q(
			`SELECT ${FILE_COLUMNS} FROM ${T("files")} WHERE status <> 'uploading' AND ($1 = 'all' OR status = $1) ORDER BY received_at DESC LIMIT 500`,
			[status],
		);
		const { rows: counts } = await q(`SELECT status, count(*)::int AS n FROM ${T("files")} WHERE status <> 'uploading' GROUP BY status`);
		// AI suggestions waiting for review.
		const { rows: pend } = await q(`SELECT file_id, max(id) AS id FROM ${T("extractions")} WHERE status = 'pending' GROUP BY file_id`);
		const pending = new Map(pend.map((p) => [String(p.file_id), p.id]));
		for (const r of rows) if (pending.has(String(r.id))) r.pending_extraction = pending.get(String(r.id));
		// Files handed to another module: what that module made of them (ctx.files outbox).
		if (rows.some((r) => r.sent_file_id != null)) {
			const out = new Map((await ctx.files.outbox({ limit: 500 })).map((o) => [String(o.id), o]));
			for (const r of rows) {
				const o = r.sent_file_id != null ? out.get(String(r.sent_file_id)) : null;
				if (o) r.handoff = { status: o.status, result: o.result };
			}
		}
		return { data: rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
	});

	ctx.route("GET", "/files/:id", async (req) => getFile(req.params.id));

	// The file's bytes, base64 (for downloading it, and for forwarding it from the page).
	ctx.route("GET", "/files/:id/content", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		const { rows } = await q(`SELECT data FROM ${T("file_chunks")} WHERE file_id = $1 ORDER BY idx`, [f.id]);
		return { id: f.id, name: f.name, content_type: f.content_type, size_bytes: f.size_bytes, data: Buffer.concat(rows.map((r) => r.data)).toString("base64") };
	});

	// POST /files/:id/sent {to, link?}: the page forwarded the file somewhere (e.g. "Auto sort statement #12").
	ctx.route("POST", "/files/:id/sent", async (req) => {
		const f = await getFile(req.params.id);
		const to = typeof req.body?.to === "string" ? req.body.to.trim().slice(0, 200) : "";
		if (!to) throw bad("to is required (where the file was sent)");
		const link = typeof req.body?.link === "string" ? req.body.link.trim() : "";
		if (link && !/^\/(?![/\\])\S{0,500}$/.test(link)) throw bad("link must be a path inside Ledger");
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		await q(
			`UPDATE ${T("files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), sent_file_id = NULL, updated_at = now() WHERE id = $1`,
			[f.id, to, link, req.user.username],
		);
		await syncNotice();
		return getFile(f.id);
	});

	// ---------------------------------------------------------------------
	// Handing files to other modules (ctx.files, Ledger >= 0.11.0)
	// ---------------------------------------------------------------------

	// GET /targets: running modules that take files, and which kinds.
	ctx.route("GET", "/targets", async () => ({ data: ctx.files.targets().filter((t) => t.id !== ctx.id) }));

	// POST /files/:id/handoff {to, kind, account_code?, note?}: send the file to that module; it is then marked sent.
	ctx.route("POST", "/files/:id/handoff", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		const b = req.body ?? {};
		const to = typeof b.to === "string" ? b.to : "";
		if (!/^[a-z][a-z0-9-]{1,31}$/.test(to) || to === ctx.id) throw bad("to must be the id of another module");
		if (!FILE_KINDS.includes(b.kind)) throw bad(`kind must be one of ${FILE_KINDS.join(", ")}`);
		const target = ctx.files.targets(b.kind).find((t) => t.id === to);
		if (!target) throw new ctx.HttpError(409, `the module "${to}" isn't running or doesn't take ${b.kind} files`);
		const meta = {};
		if (b.account_code !== undefined && b.account_code !== "") {
			if (typeof b.account_code !== "string" || !ACCOUNT_CODE_RE.test(b.account_code)) throw bad("account_code must be an account code");
			meta.account_code = b.account_code;
		}
		if (f.source_url) meta.source_url = f.source_url;
		const note = b.note === undefined ? f.note : b.note;
		if (typeof note !== "string" || note.length > 2000) throw bad("note must be text of at most 2000 characters");
		const { rows } = await q(`SELECT data FROM ${T("file_chunks")} WHERE file_id = $1 ORDER BY idx`, [f.id]);
		const data = Buffer.concat(rows.map((r) => r.data));
		const sent = await ctx.files.send(
			{ to, kind: b.kind, filename: f.name, data, contentType: /^[\w.+-]+\/[\w.+-]+$/.test(f.content_type.split(";")[0].trim()) ? f.content_type.split(";")[0].trim() : "application/octet-stream", meta, note },
			req.user,
		);
		await q(
			`UPDATE ${T("files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), sent_file_id = $5, updated_at = now() WHERE id = $1`,
			[f.id, `${target.name} (${b.kind})`.slice(0, 200), `/apps/${to}`, req.user.username, sent.id],
		);
		ctx.log.info("file handed off", { file: String(f.id), to, kind: b.kind, module_file: String(sent.id), by: req.user.username });
		await syncNotice();
		return { ...(await getFile(f.id)), handoff: { status: sent.status, result: sent.result } };
	});

	ctx.route("PATCH", "/files/:id", async (req) => {
		const f = await getFile(req.params.id);
		const b = req.body ?? {};
		const sets = [];
		const params = [f.id];
		if (b.status !== undefined) {
			if (!["new", "archived"].includes(b.status)) throw bad('status must be "new" or "archived"');
			if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
			params.push(b.status);
			sets.push(`status = $${params.length}`);
		}
		if (b.note !== undefined) {
			if (typeof b.note !== "string" || b.note.length > 1000) throw bad("note must be text of at most 1000 characters");
			params.push(b.note);
			sets.push(`note = $${params.length}`);
		}
		if (b.name !== undefined) {
			const name = typeof b.name === "string" ? b.name.trim() : "";
			if (!NAME_RE.test(name)) throw bad("name must be a file name of 1-255 characters");
			params.push(name);
			sets.push(`name = $${params.length}`);
		}
		if (sets.length === 0) throw bad("nothing to change: give status, note or name");
		await q(`UPDATE ${T("files")} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
		await syncNotice();
		return getFile(f.id);
	});

	// ---------------------------------------------------------------------
	// Extract data: a file that isn't a CSV (a PDF or text statement) is read
	// by the AI set under Settings → LLM API (ctx.llm), and its transactions become
	// a new CSV in the inbox, ready to send to Auto sort or Ledger's CSV files.
	// ---------------------------------------------------------------------

	// GET /ai: whether extraction can be offered, for the page.
	ctx.route("GET", "/ai", async () => {
		const st = await ctx.llm.status();
		// images: Ledger >= 0.11.2 (a connection for pictures, maybe another model); absent before.
		return { configured: !!st.configured, allowed: !!st.allowed, reads_pdf: !!st.readsPdf, reads_images: !!st.images?.configured, model: st.model ?? null };
	});

	// POST /files/:id/extract {instructions?} -> the new CSV file (status "new"); the original is marked sent.
	ctx.route("POST", "/files/:id/extract", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		const extra = req.body?.instructions;
		if (extra !== undefined && (typeof extra !== "string" || extra.length > 1000)) throw bad("instructions must be text of at most 1000 characters");
		const kind = extractKind(f);
		if (kind === "csv") throw bad("this file is already a CSV; send it as it is");
		if (!kind) throw bad("there's no way to extract data from this kind of file: only PDFs, photos (JPEG, PNG, GIF, WebP) and text files (TXT, OFX, QFX, HTML, XML, JSON, TSV, EML) can be read");
		if (Number(f.size_bytes) > EXTRACT_MAX_BYTES) throw new ctx.HttpError(413, `the file is larger than ${EXTRACT_MAX_BYTES / 1024 / 1024} MB, too large to extract from`);

		const st = await ctx.llm.status();
		const readsImages = !!st.images?.configured; // Ledger >= 0.11.2
		if (!st.allowed) throw new ctx.HttpError(403, `${ctx.name} isn't allowed to use the LLM API; an admin can allow it under Settings → LLM API`);
		if (kind === "text" && !st.configured) throw new ctx.HttpError(409, "no LLM connection for text is set up; an admin can add one under Settings → LLM API");
		if (kind === "image" && !readsImages) {
			throw new ctx.HttpError(409, st.images ? "no LLM connection for images is set up; an admin can add one under Settings → LLM API" : "reading photos needs Ledger 0.11.2 or newer");
		}
		if (kind === "pdf" && !st.readsPdf && !readsImages) {
			throw new ctx.HttpError(409, "reading PDFs needs an LLM connection for images (Claude reads any PDF; another vision model reads scanned ones) under Settings → LLM API");
		}

		const { rows: parts } = await q(`SELECT data FROM ${T("file_chunks")} WHERE file_id = $1 ORDER BY idx`, [f.id]);
		const bytes = Buffer.concat(parts.map((r) => r.data));
		const ask = {
			system: EXTRACT_SYSTEM,
			schema: EXTRACT_SCHEMA,
			maxTokens: 16_000,
			prompt: "",
		};
		const note = typeof extra === "string" && extra.trim() ? `\n\nThe user adds: ${extra.trim()}` : "";
		if (kind === "pdf" && st.readsPdf) {
			ask.documents = [{ media_type: "application/pdf", data: bytes.toString("base64"), name: f.name }];
			ask.prompt = `Extract every transaction from the attached document "${f.name}".${note}`;
		} else if (kind === "pdf") {
			// The image model can't read PDFs: send the photos a scanned PDF is made of.
			const jpegs = pdfJpegs(bytes);
			if (jpegs.length === 0) throw bad("this PDF has no scanned pages the image model can read; reading other PDFs needs Claude as the LLM connection for images");
			if (jpegs.length > IMAGE_MAX_COUNT) throw bad(`this PDF has more than ${IMAGE_MAX_COUNT} pages, too many to read at once`);
			if (jpegs.some((j) => j.length > IMAGE_MAX_BYTES)) throw new ctx.HttpError(413, `a page of this PDF is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
			ask.images = jpegs.map((j) => ({ media_type: "image/jpeg", data: j.toString("base64") }));
			ask.prompt = `Extract every transaction from the attached ${jpegs.length === 1 ? "picture" : `${jpegs.length} pictures (the pages, in order)`} of "${f.name}".${note}`;
		} else if (kind === "image") {
			const type = imageType(bytes);
			if (!type) throw bad("this file isn't a JPEG, PNG, GIF or WebP picture");
			if (bytes.length > IMAGE_MAX_BYTES) throw new ctx.HttpError(413, `the picture is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB; use the Scan receipt tab on a phone, which shrinks photos`);
			ask.images = [{ media_type: type, data: bytes.toString("base64") }];
			ask.prompt = `Extract every transaction from the attached picture "${f.name}".${note}`;
		} else {
			const text = readableText(bytes, f.name);
			if (text === null) throw bad("this file isn't readable text");
			if (!text.trim()) throw bad("this file is empty");
			if (text.length > EXTRACT_MAX_CHARS) throw new ctx.HttpError(413, `this file has more than ${EXTRACT_MAX_CHARS.toLocaleString("en")} characters of text, too much to extract in one go`);
			ask.prompt = `Extract every transaction from the file "${f.name}" below.${note}\n\n<file>\n${text}\n</file>`;
		}

		const result = await ctx.llm.json(ask); // its HttpErrors (409/403/422/502) say what to fix
		const tx = cleanTransactions(result.data);
		if (tx.length === 0) throw bad("the AI found no transactions in this file");
		const currency = typeof result.data?.currency === "string" && /^[A-Z]{3}$/.test(result.data.currency) ? result.data.currency : "";
		// Only a suggestion: nothing is created or changed until a person approves it.
		await q(`UPDATE ${T("extractions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE file_id = $1 AND status = 'pending'`, [f.id, req.user.username]);
		const { rows } = await q(
			`INSERT INTO ${T("extractions")} (file_id, model, currency, instructions, rows, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
			[f.id, String(result.model ?? "").slice(0, 200), currency, typeof extra === "string" ? extra.trim() : "", JSON.stringify(tx), req.user.username],
		);
		ctx.log.info("data extracted for review", { file: String(f.id), extraction: String(rows[0].id), transactions: tx.length, model: result.model, by: req.user.username });
		await syncNotice();
		return ctx.response(201, await getExtraction(rows[0].id));
	});

	async function getExtraction(id) {
		if (!/^\d+$/.test(String(id))) throw new ctx.HttpError(404, "no such extraction");
		const { rows } = await q(
			`SELECT e.id, e.file_id, f.name AS file_name, e.status, e.model, e.currency, e.instructions, e.rows, e.created_by, e.created_at, e.decided_by, e.decided_at, e.csv_file_id
			   FROM ${T("extractions")} e JOIN ${T("files")} f ON f.id = e.file_id WHERE e.id = $1`,
			[id],
		);
		if (!rows[0]) throw new ctx.HttpError(404, "no such extraction");
		return rows[0];
	}

	// GET /extractions?status=pending|approved|rejected|all: suggestions to review (without their rows).
	ctx.route("GET", "/extractions", async (req) => {
		const status = req.query.get("status") || "pending";
		if (!["pending", "approved", "rejected", "all"].includes(status)) throw bad("status must be pending, approved, rejected or all");
		const { rows } = await q(
			`SELECT e.id, e.file_id, f.name AS file_name, e.status, e.model, e.currency, jsonb_array_length(e.rows) AS transactions, e.created_by, e.created_at, e.decided_by, e.decided_at, e.csv_file_id
			   FROM ${T("extractions")} e JOIN ${T("files")} f ON f.id = e.file_id WHERE ($1 = 'all' OR e.status = $1) ORDER BY e.id DESC LIMIT 200`,
			[status],
		);
		return { data: rows };
	});

	ctx.route("GET", "/extractions/:id", async (req) => getExtraction(req.params.id));

	// POST /extractions/:id/approve {rows?}: the person's go-ahead, with their edits. Creates the CSV in the
	// inbox and moves the original file to Sent.
	ctx.route("POST", "/extractions/:id/approve", async (req) => {
		const e = await getExtraction(req.params.id);
		if (e.status !== "pending") throw new ctx.HttpError(409, `this suggestion was already ${e.status}`);
		let tx = e.rows;
		if (req.body?.rows !== undefined) {
			try {
				tx = checkRows(req.body.rows);
			} catch (err) {
				throw bad(err.message);
			}
		}
		if (tx.length === 0) throw bad("there are no transactions left; reject the suggestion instead");
		const f = await getFile(e.file_id);
		const data = Buffer.from(toCsv(tx), "utf8");
		const sha = createHash("sha256").update(data).digest("hex");
		const chunks = [];
		for (let i = 0; i < data.length; i += CHUNK_SIZE) chunks.push(data.subarray(i, i + CHUNK_SIZE));
		const name = csvName(f.name);
		const edited = req.body?.rows !== undefined && JSON.stringify(tx) !== JSON.stringify(e.rows) ? `, checked and edited by ${req.user.username}` : `, approved by ${req.user.username}`;
		const memo = `Extracted by AI (${e.model}) from ${f.name}: ${tx.length} transaction${tx.length === 1 ? "" : "s"}${e.currency ? ` in ${e.currency}` : ""}${edited}.`.slice(0, 1000);
		// One statement: the file, its bytes, and the suggestion marked approved appear together, once.
		const { rows } = await q(
			`WITH claim AS (
				UPDATE ${T("extractions")} SET status = 'approved', decided_by = $6, decided_at = now(), rows = $8::jsonb
				 WHERE id = $9 AND status = 'pending' RETURNING id
			), f AS (
				INSERT INTO ${T("files")} (name, content_type, size_bytes, sha256, status, source_url, note, received_by)
				SELECT $1, 'text/csv', $2, $3, 'new', $4, $5, $6 FROM claim RETURNING id
			), c AS (
				INSERT INTO ${T("file_chunks")} (file_id, idx, data)
				SELECT f.id, (u.n - 1)::int, u.data FROM f, unnest($7::bytea[]) WITH ORDINALITY AS u(data, n)
			)
			SELECT id FROM f`,
			[name, data.length, sha, f.source_url, memo, req.user.username, chunks, JSON.stringify(tx), e.id],
		);
		if (!rows[0]) throw new ctx.HttpError(409, "this suggestion was already decided");
		const id = rows[0].id;
		await q(`UPDATE ${T("extractions")} SET csv_file_id = $2 WHERE id = $1`, [e.id, id]);
		await q(
			`UPDATE ${T("files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), sent_file_id = NULL, updated_at = now() WHERE id = $1`,
			[f.id, `extracted to ${name}`.slice(0, 200), `/apps/${ctx.id}?file=${id}`, req.user.username],
		);
		ctx.log.info("extraction approved", { extraction: String(e.id), file: String(f.id), csv: String(id), transactions: tx.length, by: req.user.username });
		await syncNotice();
		return { ...(await getFile(id)), transactions: tx.length };
	});

	ctx.route("POST", "/extractions/:id/reject", async (req) => {
		const e = await getExtraction(req.params.id);
		if (e.status !== "pending") throw new ctx.HttpError(409, `this suggestion was already ${e.status}`);
		await q(`UPDATE ${T("extractions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`, [e.id, req.user.username]);
		await syncNotice();
		return getExtraction(e.id);
	});

	ctx.route("DELETE", "/files/:id", async (req) => {
		const f = await getFile(req.params.id);
		await q(`DELETE FROM ${T("files")} WHERE id = $1`, [f.id]);
		await syncNotice();
	});

	// ---------------------------------------------------------------------
	// Housekeeping: abandoned uploads, and old sent/archived files when Settings say so
	// ---------------------------------------------------------------------

	// Background work runs in the main books; this does it in every organization's (each has its own inbox).
	async function eachOrg(what, fn) {
		try {
			await ctx.orgs.forEach(async (org) => {
				try {
					await fn(org);
				} catch (err) {
					ctx.log.warn(`${what} failed`, { org: String(org.id), err: String(err?.message || err) });
				}
			});
		} catch (err) {
			ctx.log.warn(`${what} failed`, { err: String(err?.message || err) });
		}
	}

	async function cleanUp() {
		await eachOrg("clean-up", async (org) => {
			const { keepDays } = await options(); // each organization has its own settings (Ledger >= 0.11.1)
			const a = await q(`DELETE FROM ${T("files")} WHERE status = 'uploading' AND received_at < now() - make_interval(hours => $1)`, [STALE_UPLOAD_HOURS]);
			const b = keepDays > 0 ? await q(`DELETE FROM ${T("files")} WHERE status IN ('sent', 'archived') AND updated_at < now() - make_interval(days => $1)`, [keepDays]) : { rowCount: 0 };
			if (a.rowCount + b.rowCount > 0) {
				ctx.log.info("cleaned up", { org: String(org.id), abandoned_uploads: a.rowCount, old_files: b.rowCount });
				await syncNotice();
			}
		});
	}
	const timer = setInterval(() => cleanUp().catch(() => {}), 60 * 60 * 1000);
	timer.unref?.();
	// Not awaited: register must finish quickly.
	cleanUp()
		.then(() => eachOrg("dashboard update", syncNotice))
		.catch(() => {});

	// ---------------------------------------------------------------------
	// Email (lib/mail.mjs)
	// ---------------------------------------------------------------------

	registerMail(ctx, { q, T, saveFile, maxBytes: async () => (await options()).maxBytes, syncNotice });

	// ---------------------------------------------------------------------
	// Network scanner (lib/escl.mjs): set up by an admin, used by everyone. Scans run in the
	// background (a feeder of pages takes a while); the page polls GET /scans/:id.
	// ---------------------------------------------------------------------

	const scannerUrl = async () => String((await ctx.settings.get()).scanner_url ?? "").trim();

	// GET /scanner: the scanner set up for this organization, what it can do, and whether it's ready.
	ctx.route("GET", "/scanner", async (req) => {
		const admin = req.user.role === "admin";
		const raw = await scannerUrl();
		if (!raw) return { configured: false, admin };
		try {
			const url = normalizeScannerUrl(raw);
			const [caps, st] = await Promise.all([capabilities(url), scannerStatus(url).catch(() => null)]);
			return { configured: true, admin, reachable: true, url, name: caps.name, sources: caps.sources, state: st?.state ?? "", adf: st?.adf ?? "" };
		} catch (err) {
			if (!(err instanceof ScannerError)) throw err;
			return { configured: true, admin, reachable: false, url: raw, error: err.message };
		}
	});

	// POST /scanner/find (admins): eSCL scanners announcing themselves on the server's network.
	ctx.route("POST", "/scanner/find", async (req) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, "only an admin can set up the scanner");
		return { data: await findScanners() };
	});

	// POST /scanner {url} (admins): use this scanner ("" forgets it). It must answer as an eSCL scanner.
	ctx.route("POST", "/scanner", async (req) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, "only an admin can set up the scanner");
		const raw = req.body?.url;
		if (typeof raw !== "string" || raw.length > 300) throw bad("url must be the scanner's address");
		if (raw.trim() === "") {
			await ctx.settings.set({ scanner_url: "" });
			return { configured: false, admin: true };
		}
		let url;
		let caps;
		try {
			url = normalizeScannerUrl(raw);
			caps = await capabilities(url);
		} catch (err) {
			if (err instanceof ScannerError) throw bad(err.message);
			throw err;
		}
		await ctx.settings.set({ scanner_url: url });
		ctx.log.info("scanner set up", { url, name: caps.name, by: req.user.username });
		return { configured: true, admin: true, reachable: true, url, name: caps.name, sources: caps.sources };
	});

	const scans = new Map(); // id -> job (in memory: a scan lasts minutes, not across restarts)
	const publicScan = (j) => ({ id: j.id, status: j.status, pages: j.pages, file_id: j.file_id, file_name: j.file_name, error: j.error, started_at: j.started_at });

	// POST /scans {source?: "Platen"|"Feeder", color?: "color"|"gray", resolution?, duplex?, name?} → 202 {id, status}
	ctx.route("POST", "/scans", async (req) => {
		const b = req.body ?? {};
		if (b.source !== undefined && !["Platen", "Feeder"].includes(b.source)) throw bad('source must be "Platen" (the glass) or "Feeder"');
		if (b.color !== undefined && !["color", "gray"].includes(b.color)) throw bad('color must be "color" or "gray"');
		if (b.resolution !== undefined && !(Number.isInteger(b.resolution) && b.resolution >= 75 && b.resolution <= 1200)) throw bad("resolution must be 75 to 1200 dpi");
		if (b.duplex !== undefined && typeof b.duplex !== "boolean") throw bad("duplex must be true or false");
		let name = b.name === undefined || b.name === "" ? "" : typeof b.name === "string" ? b.name.trim() : null;
		if (name === null || (name && !NAME_RE.test(name))) throw bad("name must be a file name of 1-255 characters");
		const raw = await scannerUrl();
		if (!raw) throw new ctx.HttpError(409, "no scanner is set up; an admin can choose one on the Scan tab");
		const org = (await ctx.orgs.current()).id;
		const running = [...scans.values()].find((j) => j.status === "scanning" && j.url === raw);
		if (running) throw new ctx.HttpError(409, `the scanner is busy with ${running.by}'s scan`);
		for (const [k, j] of scans) if (j.status !== "scanning" && Date.now() - j.started > 3600_000) scans.delete(k);
		const job = { id: randomUUID(), org, url: raw, status: "scanning", pages: 0, file_id: null, file_name: null, error: null, by: req.user.username, started: Date.now(), started_at: new Date().toISOString() };
		scans.set(job.id, job);
		// Not awaited: runs on in the background, in this request's organization.
		(async () => {
			try {
				const url = normalizeScannerUrl(raw);
				const caps = await capabilities(url);
				const r = await scan(url, caps, { source: b.source, color: b.color, resolution: b.resolution ?? 300, duplex: b.duplex, onPage: (n) => (job.pages = n) });
				const jpegs = r.pages.filter((p) => p.type === "image/jpeg").map((p) => p.data);
				const data = jpegs.length === r.pages.length ? jpegsToPdf(jpegs) : r.pages[0].data;
				const { maxBytes } = await options();
				if (data.length > maxBytes) throw new ScannerError(`the scan is ${(data.length / 1048576).toFixed(1)} MB, more than the ${maxBytes / 1048576} MB allowed under Settings → ${ctx.name}; scan at a lower resolution or in grey`);
				const d = new Date();
				const p2 = (n) => String(n).padStart(2, "0");
				let fileName = name || `Scan ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.pdf`;
				if (!/\.pdf$/i.test(fileName) && data.subarray(0, 5).toString("latin1") === "%PDF-") fileName = `${fileName}.pdf`.slice(-255);
				const n = r.pages.length;
				job.file_id = await saveFile(fileName, "application/pdf", data, {
					origin: "scanner",
					detail: caps.name,
					note: `Scanned on ${caps.name}${r.source === "Feeder" ? " (feeder)" : ""}${jpegs.length ? `, ${n} page${n === 1 ? "" : "s"}` : ""}, ${r.resolution} dpi`,
					by: job.by,
				});
				job.file_name = fileName;
				job.pages = jpegs.length || job.pages;
				job.status = "done";
				await syncNotice();
			} catch (err) {
				job.status = "error";
				job.error = err instanceof ScannerError ? err.message : `the scan failed: ${String(err?.message || err)}`;
				ctx.log.warn("scan failed", { err: job.error, by: job.by });
			}
		})();
		return ctx.response(202, publicScan(job));
	});

	ctx.route("GET", "/scans/:id", async (req) => {
		const j = scans.get(req.params.id);
		if (!j || j.org !== (await ctx.orgs.current()).id) throw new ctx.HttpError(404, "no such scan");
		return publicScan(j);
	});

	// ---------------------------------------------------------------------
	// Ledger's search bar
	// ---------------------------------------------------------------------

	ctx.search.provide(async (query, { limit }) => {
		const term = String(query ?? "").trim();
		if (term.length < 2) return [];
		const like = `%${term.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		const { rows } = await q(
			`SELECT id, name, status, size_bytes, received_at FROM ${T("files")}
			  WHERE status <> 'uploading' AND (name ILIKE $1 OR source_url ILIKE $1 OR note ILIKE $1 OR origin_detail ILIKE $1) ORDER BY received_at DESC LIMIT $2`,
			[like, Math.min(limit, 20)],
		);
		return rows.map((r) => ({
			title: r.name,
			subtitle: `${r.status === "new" ? "in the inbox" : r.status} · ${(Number(r.size_bytes) / 1024).toFixed(0)} KB · ${new Date(r.received_at).toISOString().slice(0, 10)}`,
			href: `/apps/${ctx.id}?file=${r.id}`,
		}));
	});

	ctx.log.info("import module ready");
}
