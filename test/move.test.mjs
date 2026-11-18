// The hand-over's move: files in the module's old storage end up in Documents, the rows carry
// the document's id, and the storage is left empty. Against the stand-in Ledger of fake-ledger.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handoverState, kindOf, moveStoredFiles, startMoving } from "../lib/move.mjs";
import { fakeLedger } from "./fake-ledger.mjs";

const oldInstall = () =>
	fakeLedger({
		rows: [
			{ id: 1, name: "october.csv", content_type: "text/csv", note: "From the bank", storage_path: "inbox/aaa111/october.csv" },
			{ id: 2, name: "Hydro bill.eml", content_type: "message/rfc822", origin: "email", sent_to: "Auto sort (bill)", storage_path: "inbox/bbb222/Hydro bill.eml" },
			{ id: 3, name: "receipt.heic", origin: "app", storage_path: "inbox/ccc333/receipt.heic" },
			{ id: 4, name: "october (1).csv", storage_path: "inbox/ddd444/october (1).csv" }, // the same bytes as file 1, sent twice
			{ id: 5, name: "lost.ofx", storage_path: "inbox/eee555/lost.ofx" }, // its stored file is gone
			{ id: 6, name: "scan.pdf", document_id: 7, document_added_here: true }, // a PDF: in Documents all along
		],
		stored: {
			"inbox/aaa111/october.csv": "Date,Description,Amount\r\n2026-10-01,Coffee,-4.50\r\n",
			"inbox/bbb222/Hydro bill.eml": "From: hydro@example.com\r\nSubject: Your bill\r\n\r\nAmount due 82.10",
			"inbox/ccc333/receipt.heic": "a photo",
			"inbox/ddd444/october (1).csv": "Date,Description,Amount\r\n2026-10-01,Coffee,-4.50\r\n",
			"inbox/fff666/stray.qfx": "a statement no row points to",
		},
	});

test("kindOf: what the row was sent on or filed as, a receipt for phone photos, other when it doesn't say", () => {
	assert.equal(kindOf({ sent_to: "Auto sort (statement)" }), "statement");
	assert.equal(kindOf({ sent_to: "Auto sort (bill)" }), "invoice");
	assert.equal(kindOf({ sent_to: "Documents (invoice)" }), "invoice");
	assert.equal(kindOf({ sent_to: "Auto sort statement #12 (40 transactions)" }), "statement");
	assert.equal(kindOf({ sent_to: "Auto sort bill #3 (Hydro One)" }), "invoice");
	assert.equal(kindOf({ sent_to: "Sales (receipt)", origin: "email" }), "receipt");
	assert.equal(kindOf({ origin: "camera" }), "receipt");
	assert.equal(kindOf({ origin: "app", sent_to: "" }), "receipt");
	for (const row of [{}, { sent_to: "Ledger's CSV files" }, { sent_to: "Auto sort (transaction)" }, { sent_to: "extracted to may-extracted.csv" }, { origin: "email" }, null]) assert.equal(kindOf(row), "other", JSON.stringify(row));
});

test("an old install: stored files become documents, rows carry document_id, storage ends up empty", async () => {
	const L = oldInstall();
	assert.deepEqual(await handoverState(L.ctx), { files: 6, in_documents: 1, to_move: 4, missing: 1, stray: 1 });

	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 5, missing: 1, failed: 0, left: 0 });
	const row = (id) => L.rows.find((r) => r.id === id);
	const doc = (id) => L.documents.find((d) => d.id === row(id).document_id);

	// Each row points at its document and no longer at storage.
	for (const id of [1, 2, 3, 4]) assert.ok(row(id).document_id !== null && row(id).storage_path === null, `file ${id}`);
	assert.deepEqual([doc(1).kind, doc(1).filename, doc(1).origin, doc(1).note, doc(1).content_type], ["other", "october.csv", "imported", "From the bank", "text/csv"]);
	assert.equal(doc(1).data.toString(), "Date,Description,Amount\r\n2026-10-01,Coffee,-4.50\r\n");
	assert.deepEqual([doc(2).kind, doc(2).filename], ["invoice", "Hydro bill.eml"]);
	assert.equal(doc(3).kind, "receipt");
	assert.equal(doc(3).content_type, undefined, "no content type is made up for a row that has none");
	assert.deepEqual([row(1).document_added_here, row(2).document_added_here], [true, true]);
	// The same bytes twice: one document, and the second row didn't add it.
	assert.equal(row(4).document_id, row(1).document_id);
	assert.equal(row(4).document_added_here, false);
	// A stray stored file is filed too, as "other".
	const stray = L.documents.find((d) => d.filename === "stray.qfx");
	assert.deepEqual([stray.kind, stray.origin], ["other", "imported"]);
	assert.match(stray.note, /inbox\/fff666\/stray\.qfx/);
	// The row whose file is missing, and the one that was a document already, are as they were.
	assert.deepEqual([row(5).document_id, row(5).storage_path], [null, "inbox/eee555/lost.ofx"]);
	assert.deepEqual([row(6).document_id, row(6).document_added_here], [7, true]);

	assert.equal(L.storage.size, 0, "nothing is left in the module's storage");
	assert.equal(L.documents.length, 4);
	assert.deepEqual(await handoverState(L.ctx), { files: 6, in_documents: 5, to_move: 0, missing: 1, stray: 0 });

	// Running it again changes nothing.
	const before = JSON.stringify(L.rows);
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 0, missing: 1, failed: 0, left: 0 });
	assert.equal(JSON.stringify(L.rows), before);
	assert.equal(L.documents.length, 4);
});

test("a few at a time: a pass stops at its limit, and the job runs passes until nothing is left", async () => {
	const L = oldInstall();
	assert.deepEqual(await moveStoredFiles(L.ctx, { limit: 2 }), { moved: 2, missing: 0, failed: 0, left: 3 });
	assert.equal(L.storage.size, 3, "the stray file waits until the rows are done");
	assert.deepEqual(await moveStoredFiles(L.ctx, { limit: 2 }), { moved: 2, missing: 0, failed: 0, left: 1 });
	assert.deepEqual(await moveStoredFiles(L.ctx, { limit: 2 }), { moved: 1, missing: 1, failed: 0, left: 0 });
	assert.equal(L.storage.size, 0);

	// The job: every organization, again and again while files are left.
	const many = fakeLedger({
		rows: Array.from({ length: 45 }, (_, i) => ({ id: i + 1, name: `f${i}.csv`, storage_path: `inbox/x${i}/f${i}.csv` })),
		stored: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`inbox/x${i}/f${i}.csv`, `file ${i}`])),
		orgs: [{ id: 1, name: "Main books" }, { id: 2, name: "Personal" }],
	});
	const job = startMoving(many.ctx, { soon: 1, later: 1 });
	const first = await job.run();
	assert.equal(first.moved, 40, "20 in each organization's pass (the stand-in has one table for both)");
	assert.equal(first.left > 0, true);
	for (let i = 0; i < 100 && many.storage.size > 0; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(many.storage.size, 0);
	assert.ok(many.rows.every((r) => r.document_id !== null && r.storage_path === null));
	assert.equal(job.running(), false);
});

test("a file that can't be moved stays where it is, the others move, and it is tried again", async () => {
	const L = oldInstall();
	L.failEnsure = (d) => d.filename === "Hydro bill.eml";
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 4, missing: 1, failed: 1, left: 0 });
	const hydro = L.rows.find((r) => r.id === 2);
	assert.deepEqual([hydro.document_id, hydro.storage_path], [null, "inbox/bbb222/Hydro bill.eml"]);
	assert.deepEqual([...L.storage.keys()], ["inbox/bbb222/Hydro bill.eml"], "its file is still in storage, and not taken for a stray one");
	assert.ok(L.logs.some(([level, msg, attrs]) => level === "warn" && /couldn't move a file/.test(msg) && attrs.file === "2" && /disk full/.test(attrs.err)));
	assert.deepEqual(await handoverState(L.ctx), { files: 6, in_documents: 4, to_move: 1, missing: 1, stray: 0 });

	L.failEnsure = () => false;
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 1, missing: 1, failed: 0, left: 0 });
	assert.equal(hydro.storage_path, null);
	assert.equal(L.storage.size, 0);
});

test("interrupted after the row was updated: the old copy goes on the next pass, without a second document", async () => {
	const L = fakeLedger({ rows: [{ id: 1, name: "a.csv", storage_path: "inbox/a1/a.csv" }], stored: { "inbox/a1/a.csv": "a,b\r\n1,2\r\n" } });
	L.failRemove = () => true;
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 1, missing: 0, failed: 1, left: 0 });
	assert.deepEqual([L.rows[0].document_id, L.rows[0].storage_path, L.storage.size, L.documents.length], [100, null, 1, 1]);
	L.failRemove = () => false;
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 1, missing: 0, failed: 0, left: 0 });
	assert.deepEqual([L.rows[0].document_id, L.storage.size, L.documents.length], [100, 0, 1]);
});

test("an empty stored file has nothing to keep: it is removed and its row reads as missing", async () => {
	const L = fakeLedger({ rows: [{ id: 1, name: "empty.csv", storage_path: "inbox/e1/empty.csv" }], stored: { "inbox/e1/empty.csv": "", "inbox/e2/stray-empty.txt": "" } });
	assert.deepEqual(await moveStoredFiles(L.ctx), { moved: 1, missing: 1, failed: 0, left: 0 });
	assert.deepEqual([L.storage.size, L.documents.length, L.rows[0].document_id], [0, 0, null]);
	assert.deepEqual(await handoverState(L.ctx), { files: 1, in_documents: 0, to_move: 0, missing: 1, stray: 0 });
});

test("the job never rejects: a database that fails is logged and tried again later", async () => {
	const L = oldInstall();
	L.ctx.db.query = async () => { throw new Error("connection refused"); };
	const job = startMoving(L.ctx, { soon: 60_000, later: 60_000 });
	assert.deepEqual(await job.run(), { moved: 0, missing: 0, failed: 1, left: 0 });
	assert.ok(L.logs.some(([level, , attrs]) => level === "warn" && /connection refused/.test(attrs.err)));
	assert.equal(L.storage.size, 5, "nothing was touched");
});
