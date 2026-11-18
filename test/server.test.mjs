// server.mjs against the stand-in Ledger: what the last version of Import still does (the state for
// its page, the dashboard notice, the move at startup) and what it refuses (taking files in).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import register from "../server.mjs";
import { fakeLedger } from "./fake-ledger.mjs";

const settled = async (L) => {
	for (let i = 0; i < 200 && !L.logs.some(([, msg]) => /first pass done/.test(msg)); i++) await new Promise((r) => setTimeout(r, 5));
};

test("startup: register returns at once, then every organization gets the notice and its files are moved", async () => {
	const L = fakeLedger({
		rows: [{ id: 1, name: "october.csv", storage_path: "inbox/a1/october.csv" }, { id: 2, name: "scan.pdf", document_id: 7 }],
		stored: { "inbox/a1/october.csv": "Date,Amount\r\n2026-10-01,-4.50\r\n" },
		orgs: [{ id: 1, name: "Main books" }, { id: 2, name: "Personal" }],
	});
	// Slow storage: register must not wait for the move.
	const get = L.ctx.storage.get;
	L.ctx.storage.get = async (p) => (await new Promise((r) => setTimeout(r, 30)), get(p));
	await register(L.ctx);
	assert.equal(L.storage.size, 1, "the move runs in the background");
	await settled(L);
	assert.equal(L.storage.size, 0);
	assert.deepEqual([L.rows[0].document_id, L.rows[0].storage_path], [100, null]);

	// One notice per organization, with a fixed key and text (so a dismissed one stays dismissed), pointing at the page.
	assert.equal(L.notices.length, 2);
	for (const n of L.notices) {
		assert.equal(n.key, "moved-to-auto-sort");
		assert.equal(n.link, "/apps/downloads");
		assert.match(n.title, /now part of Auto sort/);
		assert.match(n.body, /0\.17\.0/);
		assert.match(n.body, /Bring over Import's files/);
	}
	assert.deepEqual(L.notices[0], L.notices[1]);
	// The old inbox notice and review to-do are taken away.
	assert.deepEqual(L.removedItems, ["notification:inbox", "todo:review", "notification:inbox", "todo:review"]);
});

test("GET /status: the hand-over's state for the page, and whether Auto sort is installed", async () => {
	const L = fakeLedger({
		rows: [{ id: 1, name: "a.csv", document_id: 5 }, { id: 2, name: "b.pdf", document_id: 6 }, { id: 3, name: "lost.ofx", storage_path: "inbox/c3/lost.ofx" }],
		targets: [{ id: "sales", name: "Sales", accepts: ["customer"] }],
	});
	await register(L.ctx);
	await settled(L);
	let s = await L.call("GET /status", { role: "viewer" });
	assert.deepEqual(
		{ ...s, moving: undefined },
		{ version: "0.22.0", organization: "Main books", role: "viewer", files: 3, in_documents: 2, to_move: 0, missing: 1, stray: 0, moving: undefined, also: { extractions: 2, emails_seen: 40, email_examples: 3 }, auto_sort: { installed: false, name: "Auto sort", needs: "0.17.0" } },
	);
	assert.equal(s.moving, false);

	const withAutoSort = fakeLedger({ targets: [{ id: "categorizer", name: "Auto sort", accepts: ["statement", "bill"] }] });
	await register(withAutoSort.ctx);
	s = await withAutoSort.call("GET /status");
	assert.deepEqual(s.auto_sort, { installed: true, name: "Auto sort", needs: "0.17.0" });
	assert.deepEqual([s.files, s.in_documents, s.to_move, s.missing], [0, 0, 0, 0]);
});

test("GET /status: files that turn up later (a restore, or a move that failed) are moved when the page asks", async () => {
	const L = fakeLedger();
	await register(L.ctx);
	await settled(L);
	L.rows.push({ id: 9, name: "late.csv", content_type: "text/csv", note: "", origin: "", sent_to: "", document_id: null, document_added_here: false, storage_path: "inbox/z9/late.csv" });
	L.storage.set("inbox/z9/late.csv", Buffer.from("x,y\r\n"));
	const s = await L.call("GET /status");
	assert.deepEqual([s.files, s.to_move, s.moving], [1, 1, true]);
	for (let i = 0; i < 200 && L.storage.size > 0; i++) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual([(await L.call("GET /status")).in_documents, L.storage.size], [1, 0]);
});

test("the routes the old extension and phone app send files to answer 410 and say where to go", async () => {
	const L = fakeLedger();
	await register(L.ctx);
	for (const [route, params, body] of [
		["POST /files", {}, { name: "statement.csv", size: 10 }],
		["POST /files", {}, {}],
		["POST /files", {}, undefined],
		["PUT /files/:id/chunks/:index", { id: "5", index: "0" }, { data: "AAAA" }],
		["POST /files/:id/complete", { id: "5" }, undefined],
		["POST /files/:id/file-as", { id: "nope" }, { kind: "receipt" }],
	]) {
		await assert.rejects(L.call(route, { params, body }), (err) => err.status === 410 && /now part of Auto sort/.test(err.message) && /new browser extension or phone app/.test(err.message), route);
	}
	// Nothing else is left that takes in or changes data.
	assert.deepEqual([...L.routes.keys()].sort(), ["GET /status", "POST /files", "POST /files/:id/complete", "POST /files/:id/file-as", "PUT /files/:id/chunks/:index"]);
});

test("the last migration refuses to drop file_chunks while a complete file is only there", async () => {
	const dir = new URL("../migrations/", import.meta.url);
	const last = (await readdir(dir)).sort().at(-1);
	assert.equal(last, "013_no_file_chunks.sql");
	const sql = await readFile(new URL(last, dir), "utf8");
	const guard = sql.indexOf("RAISE EXCEPTION");
	assert.ok(guard > 0 && guard < sql.indexOf("DELETE FROM files") && sql.indexOf("DELETE FROM files") < sql.indexOf("DROP TABLE file_chunks"), "guard, then unfinished uploads, then the table");
	assert.match(sql, /status <> 'uploading' AND f\.document_id IS NULL AND f\.storage_path IS NULL/);
	assert.match(sql, /DELETE FROM files WHERE status = 'uploading';/);
});
