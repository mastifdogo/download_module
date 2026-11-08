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
	sent_to, sent_link, sent_by, sent_at, updated_at`;

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
			`UPDATE ${T("files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), updated_at = now() WHERE id = $1`,
			[f.id, to, link, req.user.username],
		);
		await syncNotice();
		return getFile(f.id);
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

	ctx.route("DELETE", "/files/:id", async (req) => {
		const f = await getFile(req.params.id);
		await q(`DELETE FROM ${T("files")} WHERE id = $1`, [f.id]);
		await syncNotice();
	});

	// ---------------------------------------------------------------------
	// Housekeeping: abandoned uploads, and old sent/archived files when Settings say so
	// ---------------------------------------------------------------------

	async function cleanUp() {
		try {
			const { keepDays } = await options();
			const a = await q(`DELETE FROM ${T("files")} WHERE status = 'uploading' AND received_at < now() - make_interval(hours => $1)`, [STALE_UPLOAD_HOURS]);
			const b = keepDays > 0 ? await q(`DELETE FROM ${T("files")} WHERE status IN ('sent', 'archived') AND updated_at < now() - make_interval(days => $1)`, [keepDays]) : { rowCount: 0 };
			if (a.rowCount + b.rowCount > 0) ctx.log.info("cleaned up", { abandoned_uploads: a.rowCount, old_files: b.rowCount });
		} catch (err) {
			ctx.log.warn("clean-up failed", { err: String(err?.message || err) });
		}
	}
	const timer = setInterval(cleanUp, 60 * 60 * 1000);
	timer.unref?.();
	cleanUp(); // not awaited: register must finish quickly

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

	await syncNotice();
	ctx.log.info("downloads module ready");
}
