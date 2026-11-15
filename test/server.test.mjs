// The inbox routes of server.mjs against a stand-in Ledger: routes are collected, SQL is recorded
// and answered from a file row and its chunks, Documents and file storage are lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";

async function fakeLedger({ file = null, chunks = [] } = {}) {
	const routes = new Map();
	const sql = [];
	const documents = [];
	const stored = [];
	const ctx = {
		id: "downloads", name: "Import", schema: "mod_downloads", version: "0.0.0", ledgerVersion: "0.19.8",
		route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
		HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
		response: (status, body) => ({ status, body }),
		db: {
			query: async (text, params = []) => {
				sql.push({ text, params });
				if (/^SELECT id, name, content_type/.test(text) && /WHERE id = \$1/.test(text)) return { rows: file ? [{ ...file }] : [], rowCount: file ? 1 : 0 };
				if (/^SELECT (chunk_index, )?data FROM mod_downloads\.file_chunks/.test(text)) return { rows: chunks.map((data, chunk_index) => ({ chunk_index, data })), rowCount: chunks.length };
				if (/^INSERT INTO mod_downloads\.files/.test(text)) return { rows: [{ id: 7 }], rowCount: 1 };
				return { rows: [], rowCount: 1 };
			},
		},
		settings: { get: async () => ({}) },
		orgs: { forEach: async () => {}, current: async () => ({ id: 1 }) },
		dashboard: { notify: async () => {}, todo: async () => {}, remove: async () => {} },
		log: { info() {}, warn() {}, error() {} },
		search: { provide() {} },
		documents: { add: async (d) => (documents.push(d), { id: 31 }), update: async () => {}, url: (id) => `/api/v1/documents/${id}/file` },
		storage: { put: async (path, data) => void stored.push({ path, data }), remove: async () => true, url: (path) => `/storage/${path}` },
		files: { targets: () => [], outbox: async () => [] },
		llm: { status: async () => ({}) },
		mail: { status: async () => ({ connected: false }) },
	};
	await register(ctx);
	const user = { username: "pat", role: "bookkeeper" };
	const call = (route, { params = {}, body } = {}) => routes.get(route)({ params, body, query: new URLSearchParams(), user });
	return { call, sql, documents, stored };
}

const FILE = { id: 5, name: "bill.pdf", content_type: "application/pdf", size_bytes: 30, status: "new", source_url: "", note: "", origin: "", document_id: null, storage_path: "inbox/abc/bill.pdf" };
const markedSent = (L) => L.sql.some((s) => /SET status = 'sent'/.test(s.text));

test("POST /files/:id/sent: a wrong kind is refused before the file is marked sent", async () => {
	for (const kind of ["nope", "constructor", "__proto__", 7, null]) {
		const L = await fakeLedger({ file: FILE });
		await assert.rejects(L.call("POST /files/:id/sent", { params: { id: "5" }, body: { to: "Auto sort bill #3", kind } }), (err) => err.status === 422 && /kind must be/.test(err.message), `kind ${String(kind)}`);
		assert.ok(!markedSent(L), `kind ${String(kind)}: the file isn't marked sent`);
	}
	for (const body of [{ to: "Auto sort bill #3", kind: "bill" }, { to: "Ledger's CSV files", link: "/files" }]) {
		const L = await fakeLedger({ file: FILE });
		await L.call("POST /files/:id/sent", { params: { id: "5" }, body });
		assert.ok(markedSent(L));
	}
});

test("POST /files: a source_url that isn't an address is left out (the page shows its host)", async () => {
	const sourceOf = async (source_url) => {
		const L = await fakeLedger();
		const r = await L.call("POST /files", { body: { name: "statement.csv", size: 10, source_url } });
		assert.equal(r.status, 201);
		return L.sql.find((s) => /^INSERT INTO mod_downloads\.files/.test(s.text)).params[3];
	};
	assert.equal(await sourceOf("https://bank.example/statements/oct.csv?x=1"), "https://bank.example/statements/oct.csv?x=1");
	for (const bad of ["http://[", "https://exa mple.com/a", "ftp://bank.example/a", "javascript:alert(1)", 42]) assert.equal(await sourceOf(bad), "", String(bad));
});

test("a complete upload: PDFs and real PNG or JPEG pictures go to Documents, a cut-off PNG to file storage", async () => {
	const settle = async (name, data) => {
		const L = await fakeLedger({ file: { ...FILE, name, status: "uploading", size_bytes: data.length, storage_path: null }, chunks: [data] });
		await L.call("POST /files/:id/complete", { params: { id: "5" } });
		return L;
	};
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
	for (const [name, data] of [["scan.png", png], ["bill.pdf", Buffer.from("%PDF-1.4 a bill")], ["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])]]) {
		const L = await settle(name, data);
		assert.deepEqual([L.documents.length, L.stored.length], [1, 0], name);
		assert.equal(L.documents[0].filename, name);
	}
	// Ledger's Documents refuses a PNG without its whole signature: it must not be offered there.
	const cut = await settle("broken.png", Buffer.from("\x89PNG not really a png, cut off", "latin1"));
	assert.deepEqual([cut.documents.length, cut.stored.length], [0, 1]);
	assert.match(cut.stored[0].path, /^inbox\/[0-9a-f]{12}\/broken\.png$/);
});
