// Downloads: an inbox in Ledger for files sent from the browser (the Send to
// Ledger extension in ui/extension/). Ledger loads this file at startup and
// calls register(ctx); API: docs/MODULE_LLM_CONTEXT.md in the Ledger repository.
//
// Upload (the extension does this from a Ledger tab, with the user's login):
//   POST /files {name, content_type, size, source_url?}  -> {id, chunk_size}
//   PUT  /files/:id/chunks/:index {data: base64}         (each chunk <= chunk_size bytes)
//   POST /files/:id/complete                              -> the file
// Chunks keep each request under Ledger's 1 MiB JSON limit.

import { createHash } from "node:crypto";

const CHUNK_SIZE = 512 * 1024; // bytes; base64 makes it ~700 KB, under Ledger's 1 MiB body limit
const STALE_UPLOAD_HOURS = 24;
const NAME_RE = /^[^\u0000-\u001f/\\]{1,255}$/;
const FILE_COLUMNS = `id, name, content_type, size_bytes, sha256, status, source_url, note, received_by, received_at,
	sent_to, sent_link, sent_by, sent_at, sent_file_id, updated_at`;
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

/** "csv", "pdf", "text", or null when the file can't be read. */
function extractKind(f) {
	const type = String(f.content_type || "").toLowerCase();
	if (/\.csv$/i.test(f.name) || /^text\/csv\b/.test(type)) return "csv";
	if (/\.pdf$/i.test(f.name) || /^application\/pdf\b/.test(type)) return "pdf";
	if (TEXT_EXT_RE.test(f.name) || TEXT_TYPE_RE.test(type)) return "text";
	return null;
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

	// ---------------------------------------------------------------------
	// Dashboard: one notification while files wait in the inbox
	// ---------------------------------------------------------------------

	async function syncNotice() {
		try {
			const { rows } = await q(`SELECT name FROM ${T("files")} WHERE status = 'new' ORDER BY received_at DESC`);
			if (rows.length === 0) return void (await ctx.dashboard.remove("inbox", "notification"));
			const n = rows.length;
			await ctx.dashboard.notify({
				key: "inbox",
				title: `${n} file${n === 1 ? "" : "s"} waiting in ${ctx.name}`,
				body: rows.slice(0, 3).map((r) => r.name).join(", ") + (n > 3 ? ", …" : ""),
				level: "info",
				link: `/apps/${ctx.id}`,
			});
		} catch (err) {
			ctx.log.warn("dashboard update failed", { err: String(err?.message || err) });
		}
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
		const { rows } = await q(
			`INSERT INTO ${T("files")} (name, content_type, size_bytes, source_url, received_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[name, type, size, source, req.user.username],
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
	// by the AI set under Settings → AI (ctx.llm), and its transactions become
	// a new CSV in the inbox, ready to send to Auto sort or Ledger's CSV files.
	// ---------------------------------------------------------------------

	// GET /ai: whether extraction can be offered, for the page.
	ctx.route("GET", "/ai", async () => {
		const st = await ctx.llm.status();
		return { configured: !!st.configured, allowed: !!st.allowed, reads_pdf: !!st.readsPdf, model: st.model ?? null };
	});

	// POST /files/:id/extract {instructions?} -> the new CSV file (status "new"); the original is marked sent.
	ctx.route("POST", "/files/:id/extract", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		const extra = req.body?.instructions;
		if (extra !== undefined && (typeof extra !== "string" || extra.length > 1000)) throw bad("instructions must be text of at most 1000 characters");
		const kind = extractKind(f);
		if (kind === "csv") throw bad("this file is already a CSV; send it as it is");
		if (!kind) throw bad("there's no way to extract data from this kind of file: only PDFs and text files (TXT, OFX, QFX, HTML, XML, JSON, TSV, EML) can be read");
		if (Number(f.size_bytes) > EXTRACT_MAX_BYTES) throw new ctx.HttpError(413, `the file is larger than ${EXTRACT_MAX_BYTES / 1024 / 1024} MB, too large to extract from`);

		const st = await ctx.llm.status();
		if (!st.configured) throw new ctx.HttpError(409, "no AI provider is set up; an admin can choose one under Settings → AI");
		if (!st.allowed) throw new ctx.HttpError(403, `${ctx.name} isn't allowed to use AI; an admin can allow it under Settings → AI`);
		if (kind === "pdf" && !st.readsPdf) throw bad("the AI provider set under Settings → AI can't read PDFs (only Claude can); extract from a text file instead");

		const { rows: parts } = await q(`SELECT data FROM ${T("file_chunks")} WHERE file_id = $1 ORDER BY idx`, [f.id]);
		const bytes = Buffer.concat(parts.map((r) => r.data));
		const ask = {
			system: EXTRACT_SYSTEM,
			schema: EXTRACT_SCHEMA,
			maxTokens: 16_000,
			prompt: "",
		};
		const note = typeof extra === "string" && extra.trim() ? `\n\nThe user adds: ${extra.trim()}` : "";
		if (kind === "pdf") {
			ask.documents = [{ media_type: "application/pdf", data: bytes.toString("base64"), name: f.name }];
			ask.prompt = `Extract every transaction from the attached document "${f.name}".${note}`;
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
		const csv = toCsv(tx);
		const data = Buffer.from(csv, "utf8");
		const sha = createHash("sha256").update(data).digest("hex");
		const chunks = [];
		for (let i = 0; i < data.length; i += CHUNK_SIZE) chunks.push(data.subarray(i, i + CHUNK_SIZE));
		const name = csvName(f.name);
		const currency = typeof result.data?.currency === "string" && /^[A-Z]{3}$/.test(result.data.currency) ? ` in ${result.data.currency}` : "";
		const memo = `Extracted by AI (${result.model}) from ${f.name}: ${tx.length} transaction${tx.length === 1 ? "" : "s"}${currency}. Check it before posting.`.slice(0, 1000);
		// One statement, so the file and its bytes appear together.
		const { rows } = await q(
			`WITH f AS (
				INSERT INTO ${T("files")} (name, content_type, size_bytes, sha256, status, source_url, note, received_by)
				VALUES ($1, 'text/csv', $2, $3, 'new', $4, $5, $6) RETURNING id
			), c AS (
				INSERT INTO ${T("file_chunks")} (file_id, idx, data)
				SELECT f.id, (u.n - 1)::int, u.data FROM f, unnest($7::bytea[]) WITH ORDINALITY AS u(data, n)
			)
			SELECT id FROM f`,
			[name, data.length, sha, f.source_url, memo, req.user.username, chunks],
		);
		const id = rows[0].id;
		await q(
			`UPDATE ${T("files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), sent_file_id = NULL, updated_at = now() WHERE id = $1`,
			[f.id, `extracted to ${name}`.slice(0, 200), `/apps/${ctx.id}?file=${id}`, req.user.username],
		);
		ctx.log.info("data extracted", { file: String(f.id), csv: String(id), transactions: tx.length, model: result.model, by: req.user.username });
		await syncNotice();
		return ctx.response(201, { ...(await getFile(id)), transactions: tx.length, model: result.model });
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
		const { keepDays } = await options();
		await eachOrg("clean-up", async (org) => {
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
	// Ledger's search bar
	// ---------------------------------------------------------------------

	ctx.search.provide(async (query, { limit }) => {
		const term = String(query ?? "").trim();
		if (term.length < 2) return [];
		const like = `%${term.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		const { rows } = await q(
			`SELECT id, name, status, size_bytes, received_at FROM ${T("files")}
			  WHERE status <> 'uploading' AND (name ILIKE $1 OR source_url ILIKE $1 OR note ILIKE $1) ORDER BY received_at DESC LIMIT $2`,
			[like, Math.min(limit, 20)],
		);
		return rows.map((r) => ({
			title: r.name,
			subtitle: `${r.status === "new" ? "in the inbox" : r.status} · ${(Number(r.size_bytes) / 1024).toFixed(0)} KB · ${new Date(r.received_at).toISOString().slice(0, 10)}`,
			href: `/apps/${ctx.id}?file=${r.id}`,
		}));
	});

	ctx.log.info("downloads module ready");
}
