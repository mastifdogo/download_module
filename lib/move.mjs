// The hand-over's one job: every file Import still keeps in its own storage (ctx.storage: CSV, OFX,
// saved emails… from before Ledger 0.26.0) is filed in Ledger's Documents, and its inbox row gets
// the document's id. PDFs and scans were filed there all along. Safe to run again at any point:
// a file is only removed from storage once its row points at the document.

/** How many files one pass moves in an organization before the next pass is scheduled. */
export const BATCH = 20;

const KIND_OF = { statement: "statement", bill: "invoice", invoice: "invoice", receipt: "receipt" };

/**
 * The Documents folder an inbox row implies: what it was sent on or filed as ("Auto sort (bill)",
 * "Documents (statement)", "Auto sort statement #12 (40 transactions)"), a receipt for photos from
 * the camera or the phone app, "other" when the row doesn't say.
 */
export function kindOf(row) {
	const sent = String(row?.sent_to ?? "");
	const m = /\((statement|bill|invoice|receipt)\)$/i.exec(sent) ?? /^Auto sort (statement|bill) #\d/i.exec(sent);
	if (m) return KIND_OF[m[1].toLowerCase()];
	return row?.origin === "camera" || row?.origin === "app" ? "receipt" : "other";
}

/** A name Documents takes: one line, no folders, 1-255 characters. */
function fileName(name) {
	const n = String(name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").split(/[\\/]/).pop().trim().slice(0, 255).trim();
	return n || "file";
}

const say = (err) => String(err?.message || err);

/**
 * One pass in the organization the code runs in: moves up to `limit` stored files into Documents.
 * → { moved, missing, failed, left }: rows moved (and stray files filed), rows whose stored file
 * isn't there (left as they are), files that couldn't be moved this time, and files not reached yet.
 */
export async function moveStoredFiles(ctx, { limit = BATCH } = {}) {
	const files = `${ctx.schema}.files`;
	const out = { moved: 0, missing: 0, failed: 0, left: 0 };
	const warn = (what, attrs, err) => {
		out.failed++;
		ctx.log.warn(what, { ...attrs, err: say(err) });
	};

	// 1. Files an inbox row points to.
	const { rows } = await ctx.db.query(
		`SELECT id, name, content_type, note, origin, sent_to, storage_path FROM ${files}
		  WHERE storage_path IS NOT NULL AND document_id IS NULL ORDER BY id`,
	);
	for (const f of rows) {
		if (out.moved >= limit) {
			out.left++;
			continue;
		}
		try {
			// A path storage wouldn't take (a damaged row) has no file either.
			const got = await ctx.storage.stat(f.storage_path).then((st) => st && ctx.storage.get(f.storage_path), () => null);
			if (!got) {
				out.missing++;
				continue;
			}
			if (got.data.length === 0) {
				// Documents takes no empty file, and there is nothing in it to keep: the row then reads as missing.
				await ctx.storage.remove(f.storage_path);
				out.missing++;
				continue;
			}
			const type = String(f.content_type ?? "").trim();
			const { document, added } = await ctx.documents.ensure({
				kind: kindOf(f),
				filename: fileName(f.name),
				data: got.data,
				origin: "imported",
				note: String(f.note ?? "").slice(0, 2000),
				...(type ? { content_type: type } : {}),
			});
			const { rowCount } = await ctx.db.query(
				`UPDATE ${files} SET document_id = $2, document_added_here = $3, storage_path = NULL
				  WHERE id = $1 AND storage_path = $4 AND document_id IS NULL`,
				[f.id, document.id, added === true, f.storage_path],
			);
			// The row went away meanwhile: its file stays in storage and is filed as a stray one below.
			if (!rowCount) continue;
			out.moved++;
			await ctx.storage.remove(f.storage_path).catch((err) => ctx.log.warn("moved a file into Documents but couldn't remove the old copy; the next pass does", { file: String(f.id), path: f.storage_path, err: say(err) }));
		} catch (err) {
			warn("couldn't move a file into Documents; it stays where it is and is tried again", { file: String(f.id), path: f.storage_path }, err);
		}
	}
	if (out.left > 0) return out;

	// 2. Stray files no row points to (left by a restore, a deletion, or an interrupted move): filed
	// too, as "other", so nothing is left behind in the module's storage.
	let stored;
	try {
		stored = await ctx.storage.list("");
	} catch (err) {
		warn("couldn't list the module's stored files", {}, err);
		return out;
	}
	if (stored.length === 0) return out;
	const known = new Set((await ctx.db.query(`SELECT storage_path FROM ${files} WHERE storage_path IS NOT NULL AND document_id IS NULL`)).rows.map((r) => r.storage_path));
	for (const s of stored) {
		if (known.has(s.path)) continue; // a row's file that couldn't be moved above
		if (out.moved >= limit) {
			out.left++;
			continue;
		}
		try {
			const got = await ctx.storage.get(s.path);
			if (!got) continue;
			if (got.data.length > 0) {
				await ctx.documents.ensure({
					kind: "other",
					filename: fileName(s.path),
					data: got.data,
					origin: "imported",
					note: `Was in Import's own file storage (${s.path}) with no inbox entry.`.slice(0, 2000),
				});
			}
			await ctx.storage.remove(s.path);
			out.moved++;
		} catch (err) {
			warn("couldn't move a stray stored file into Documents; it stays where it is and is tried again", { path: s.path }, err);
		}
	}
	return out;
}

/**
 * Where the hand-over stands in the organization the code runs in:
 * { files, in_documents, to_move, missing, stray }.
 */
export async function handoverState(ctx) {
	const files = `${ctx.schema}.files`;
	const [{ rows: counts }, { rows: waiting }, stored] = await Promise.all([
		ctx.db.query(`SELECT count(*)::int AS files, count(document_id)::int AS in_documents FROM ${files}`),
		ctx.db.query(`SELECT storage_path FROM ${files} WHERE document_id IS NULL`),
		ctx.storage.list("").catch(() => []),
	]);
	const there = new Set(stored.map((s) => s.path));
	const rowPaths = new Set();
	let toMove = 0;
	for (const r of waiting) {
		if (r.storage_path && there.has(r.storage_path)) {
			toMove++;
			rowPaths.add(r.storage_path);
		}
	}
	return {
		files: Number(counts[0]?.files ?? 0),
		in_documents: Number(counts[0]?.in_documents ?? 0),
		to_move: toMove,
		missing: waiting.length - toMove, // no document, and no stored file to make one from
		stray: stored.filter((s) => !rowPaths.has(s.path)).length, // stored files no row points to; they are filed too
	};
}

/**
 * The background job: a pass over every organization now, then again while anything is left
 * (soon after a pass that moved files, later after one that only failed).
 * → { run(), running() }; run() never rejects and never runs two passes at once.
 */
export function startMoving(ctx, { soon = 2000, later = 10 * 60_000 } = {}) {
	let current = null;
	let timer = null;

	async function pass() {
		const total = { moved: 0, missing: 0, failed: 0, left: 0 };
		try {
			await ctx.orgs.forEach(async (org) => {
				try {
					const r = await moveStoredFiles(ctx);
					for (const k of Object.keys(total)) total[k] += r[k];
					if (r.moved || r.failed) ctx.log.info("moved Import's stored files into Documents", { org: String(org.id), ...r });
				} catch (err) {
					total.failed++;
					ctx.log.warn("moving Import's stored files into Documents failed", { org: String(org.id), err: say(err) });
				}
			});
		} catch (err) {
			total.failed++;
			ctx.log.warn("moving Import's stored files into Documents failed", { err: say(err) });
		}
		return total;
	}

	function run() {
		if (current) return current;
		clearTimeout(timer);
		timer = null;
		current = pass().then((total) => {
			current = null;
			if (total.left > 0 || total.failed > 0) {
				timer = setTimeout(run, total.moved > 0 ? soon : later);
				timer.unref?.();
			}
			return total;
		});
		return current;
	}

	return { run, running: () => current !== null };
}
