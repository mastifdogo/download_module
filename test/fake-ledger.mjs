// A stand-in Ledger for the tests: the inbox table (mod_downloads.files) is a list of rows answered
// by the SQL the module sends, the module's old file storage is a Map, and Documents is a list that
// refuses the same bytes twice the way Ledger does (ensure() returns the document that has them).
import { createHash } from "node:crypto";

export function fakeLedger({ rows = [], stored = {}, orgs = [{ id: 1, name: "Main books", kind: "business" }], targets = [] } = {}) {
	const L = {
		rows: rows.map((r) => ({ content_type: "", note: "", origin: "", sent_to: "", document_id: null, document_added_here: false, storage_path: null, ...r })),
		storage: new Map(Object.entries(stored).map(([p, d]) => [p, Buffer.from(d)])),
		documents: [],
		notices: [],
		removedItems: [],
		routes: new Map(),
		logs: [],
		failEnsure: () => false, // (document) → true to make Documents refuse it
		failRemove: () => false, // (path) → true to make storage.remove fail
	};
	const sql = async (text, params = []) => {
		const t = text.replace(/\s+/g, " ").trim();
		if (/^SELECT id, name, content_type, note, origin, sent_to, storage_path FROM mod_downloads\.files WHERE storage_path IS NOT NULL AND document_id IS NULL ORDER BY id$/.test(t)) {
			return { rows: L.rows.filter((r) => r.storage_path !== null && r.document_id === null).sort((a, b) => a.id - b.id).map((r) => ({ ...r })) };
		}
		if (/^UPDATE mod_downloads\.files SET document_id = \$2, document_added_here = \$3, storage_path = NULL WHERE id = \$1 AND storage_path = \$4 AND document_id IS NULL$/.test(t)) {
			const r = L.rows.find((x) => x.id === params[0] && x.storage_path === params[3] && x.document_id === null);
			if (r) Object.assign(r, { document_id: params[1], document_added_here: params[2], storage_path: null });
			return { rows: [], rowCount: r ? 1 : 0 };
		}
		if (/^SELECT storage_path FROM mod_downloads\.files WHERE storage_path IS NOT NULL AND document_id IS NULL$/.test(t)) {
			return { rows: L.rows.filter((r) => r.storage_path !== null && r.document_id === null).map((r) => ({ storage_path: r.storage_path })) };
		}
		if (/^SELECT storage_path FROM mod_downloads\.files WHERE document_id IS NULL$/.test(t)) {
			return { rows: L.rows.filter((r) => r.document_id === null).map((r) => ({ storage_path: r.storage_path })) };
		}
		if (/^SELECT count\(\*\)::int AS files, count\(document_id\)::int AS in_documents FROM mod_downloads\.files$/.test(t)) {
			return { rows: [{ files: L.rows.length, in_documents: L.rows.filter((r) => r.document_id !== null).length }] };
		}
		if (/^SELECT \(SELECT count\(\*\)::int FROM mod_downloads\.extractions\) AS extractions/.test(t)) return { rows: [{ extractions: 2, emails_seen: 40, email_examples: 3 }] };
		throw new Error(`the fake Ledger doesn't know this SQL: ${t}`);
	};
	const info = (path) => ({ path, size: L.storage.get(path).length, content_type: "application/octet-stream", modified_at: new Date(), url: `/storage/${path}` });
	L.ctx = {
		id: "downloads", name: "Import", schema: "mod_downloads", version: "0.22.0", ledgerVersion: "0.27.0",
		route: (method, path, fn) => L.routes.set(`${method} ${path}`, fn),
		HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
		response: (status, body) => ({ status, body }),
		db: { query: sql },
		orgs: { forEach: async (fn) => { for (const o of orgs) await fn(o); } },
		dashboard: {
			notify: async (n) => void L.notices.push(n),
			remove: async (key, kind = "todo") => void L.removedItems.push(`${kind}:${key}`),
		},
		log: { info: (msg, attrs) => L.logs.push(["info", msg, attrs]), warn: (msg, attrs) => L.logs.push(["warn", msg, attrs]), error: (msg, attrs) => L.logs.push(["error", msg, attrs]) },
		files: { targets: () => targets },
		storage: {
			// Ledger 0.27.0: a module built for it can't save here any more.
			put: async () => { throw Object.assign(new Error("storage.put: modules keep no files of their own"), { status: 410 }); },
			stat: async (path) => (L.storage.has(path) ? info(path) : null),
			get: async (path) => (L.storage.has(path) ? { ...info(path), data: L.storage.get(path) } : null),
			list: async () => [...L.storage.keys()].sort().map(info),
			remove: async (path) => {
				if (L.failRemove(path)) throw new Error("EACCES");
				return L.storage.delete(path);
			},
		},
		documents: {
			ensure: async (d) => {
				if (!Buffer.isBuffer(d.data) || d.data.length === 0) throw Object.assign(new Error("validation failed: data: is empty"), { status: 422 });
				if (L.failEnsure(d)) throw new Error("could not save the document: disk full");
				const sha256 = createHash("sha256").update(d.data).digest("hex");
				const have = L.documents.find((x) => x.sha256 === sha256);
				if (have) return { document: have, added: false };
				const document = { id: 100 + L.documents.length, sha256, source: "downloads", ...d };
				L.documents.push(document);
				return { document, added: true };
			},
		},
	};
	L.call = (route, { params = {}, body, role = "admin" } = {}) => L.routes.get(route)({ params, body, query: new URLSearchParams(), user: { username: "pat", role, organization: orgs[0] } });
	return L;
}
