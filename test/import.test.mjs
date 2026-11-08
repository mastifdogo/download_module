import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { capabilities, isLocalAddress, normalizeScannerUrl, parseDns, scan, ScannerError, status } from "../lib/escl.mjs";
import { emailDocuments, gmailQuery, looksLikeBill, sentByMe } from "../lib/mail.mjs";
import { parseEmail } from "../lib/mime.mjs";
import { jpegInfo, jpegsToPdf } from "../lib/pdf.mjs";
import { sampleEmail } from "./helpers.mjs";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAA8ACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z", "base64"); // 40 x 60, RGB

test("jpegInfo reads a JPEG's size; jpegsToPdf makes one page per JPEG", () => {
	assert.deepEqual(jpegInfo(JPEG), { width: 40, height: 60, components: 3 });
	assert.equal(jpegInfo(Buffer.from("%PDF-1.4")), null);
	const pdf = jpegsToPdf([JPEG, JPEG]).toString("latin1");
	assert.match(pdf, /^%PDF-1\.4/);
	assert.match(pdf, /\/Count 2/);
	assert.equal(pdf.match(/\/DCTDecode/g).length, 2);
	// every xref offset points at its object
	const xref = pdf.slice(pdf.lastIndexOf("xref"));
	const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
	offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
	assert.throws(() => jpegsToPdf([Buffer.from("nope")]), /isn't a JPEG/);
});

test("only scanners on the local network", () => {
	for (const ip of ["192.168.1.40", "10.0.0.5", "172.20.1.1", "169.254.3.4", "100.101.102.103", "127.0.0.1", "fd12::1", "fe80::1", "::1", "::ffff:192.168.0.2"]) assert.ok(isLocalAddress(ip), ip);
	for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isLocalAddress(ip), ip);
	assert.equal(normalizeScannerUrl("192.168.1.40"), "http://192.168.1.40/eSCL");
	assert.equal(normalizeScannerUrl("https://scanner.local:443/eSCL/"), "https://scanner.local/eSCL");
	assert.equal(normalizeScannerUrl("http://10.0.0.9:8080/escl"), "http://10.0.0.9:8080/escl");
	assert.throws(() => normalizeScannerUrl("http://u:p@10.0.0.1"), ScannerError);
	assert.throws(() => normalizeScannerUrl(""), ScannerError);
});

test("a public address is refused before any request", async () => {
	await assert.rejects(capabilities("http://8.8.8.8/eSCL"), /isn't on your local network/);
});

/** A fake eSCL scanner: glass and a feeder holding `sheets` pages. */
function fakeScanner({ sheets = 2, format = "image/jpeg" } = {}) {
	const log = [];
	let left = 0;
	let jobs = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			log.push(`${req.method} ${req.url}`);
			if (req.url === "/eSCL/ScannerCapabilities") {
				res.setHeader("Content-Type", "text/xml");
				return res.end(`<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="x" xmlns:pwg="y"><pwg:MakeAndModel>Acme Scan &amp; Print 9</pwg:MakeAndModel>
					<scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight>
					<scan:SettingProfiles><scan:SettingProfile><scan:ColorModes><scan:ColorMode>RGB24</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode></scan:ColorModes>
					<scan:DocumentFormats><pwg:DocumentFormat>${format}</pwg:DocumentFormat></scan:DocumentFormats>
					<scan:SupportedResolutions><scan:DiscreteResolutions><scan:DiscreteResolution><scan:XResolution>150</scan:XResolution></scan:DiscreteResolution><scan:DiscreteResolution><scan:XResolution>300</scan:XResolution></scan:DiscreteResolution></scan:DiscreteResolutions></scan:SupportedResolutions>
					</scan:SettingProfile></scan:SettingProfiles></scan:PlatenInputCaps></scan:Platen>
					<scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight><scan:ColorMode>RGB24</scan:ColorMode><pwg:DocumentFormat>${format}</pwg:DocumentFormat><scan:XResolution>200</scan:XResolution></scan:AdfSimplexInputCaps><scan:AdfDuplexInputCaps/></scan:Adf>
					</scan:ScannerCapabilities>`);
			}
			if (req.url === "/eSCL/ScannerStatus") return res.end("<scan:ScannerStatus><pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfLoaded</scan:AdfState></scan:ScannerStatus>");
			if (req.method === "POST" && req.url === "/eSCL/ScanJobs") {
				log.push(body);
				left = /<pwg:InputSource>Feeder/.test(body) ? sheets : 1;
				res.statusCode = 201;
				res.setHeader("Location", `/eSCL/ScanJobs/job${++jobs}`);
				return res.end();
			}
			if (/^\/eSCL\/ScanJobs\/job\d+\/NextDocument$/.test(req.url)) {
				if (left-- > 0) {
					res.setHeader("Content-Type", format);
					return res.end(format === "image/jpeg" ? JPEG : Buffer.from("%PDF-1.4 all pages"));
				}
				res.statusCode = 404;
				return res.end();
			}
			if (req.method === "DELETE") return res.end();
			res.statusCode = 404;
			res.end();
		});
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ root: `http://127.0.0.1:${server.address().port}/eSCL`, log, close: () => server.close() })));
}

test("eSCL: capabilities, status, a glass scan and a feeder scan", async () => {
	const s = await fakeScanner({ sheets: 3 });
	try {
		const caps = await capabilities(s.root);
		assert.equal(caps.name, "Acme Scan & Print 9");
		assert.deepEqual(caps.sources.map((x) => x.id), ["Platen", "Feeder"]);
		assert.deepEqual(caps.sources[0].resolutions, [150, 300]);
		assert.deepEqual(caps.sources[0].colorModes, ["RGB24", "Grayscale8"]);
		assert.equal(caps.sources[1].duplex, true);
		assert.deepEqual(await status(s.root), { state: "Idle", adf: "ScannerAdfLoaded" });

		const glass = await scan(s.root, caps, { source: "Platen", color: "gray", resolution: 280 });
		assert.equal(glass.pages.length, 1);
		assert.equal(glass.resolution, 300);
		assert.match(s.log.find((l) => l.includes("ScanSettings")), /Grayscale8[\s\S]*<scan:XResolution>300/);

		let seen = 0;
		const feeder = await scan(s.root, caps, { source: "Feeder", duplex: true, onPage: (n) => (seen = n) });
		assert.equal(feeder.pages.length, 3);
		assert.equal(seen, 3);
		assert.ok(feeder.pages.every((p) => p.type === "image/jpeg"));
		assert.match(s.log.filter((l) => l.includes("ScanSettings")).at(-1), /<scan:Duplex>true/);
		await new Promise((r) => setTimeout(r, 100)); // the job is cleaned up without waiting
		assert.ok(s.log.includes("DELETE /eSCL/ScanJobs/job2"));
	} finally {
		s.close();
	}
});

test("eSCL: a scanner offering only PDF gives one PDF for the whole feeder", async () => {
	const s = await fakeScanner({ sheets: 4, format: "application/pdf" });
	try {
		const r = await scan(s.root, await capabilities(s.root), { source: "Feeder" });
		assert.equal(r.pages.length, 1);
		assert.equal(r.pages[0].type, "application/pdf");
	} finally {
		s.close();
	}
});

test("eSCL: something that isn't a scanner", async () => {
	const server = http.createServer((req, res) => res.end("<html>router</html>"));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		await assert.rejects(capabilities(`http://127.0.0.1:${server.address().port}/eSCL`), /doesn't answer as an eSCL/);
	} finally {
		server.close();
	}
});

test("mDNS answers: PTR, SRV, TXT and A records", () => {
	const name = (n) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
	const rr = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([name(n), h, data]); };
	const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x01, 0xbb]), name("acme.local")]);
	const txt = Buffer.concat(["rs=eSCL", "ty=Acme 9"].map((t) => Buffer.concat([Buffer.from([t.length]), Buffer.from(t)])));
	const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
	const msg = Buffer.concat([header, rr("_uscans._tcp.local", 12, name("Acme._uscans._tcp.local")), rr("Acme._uscans._tcp.local", 33, srv), rr("Acme._uscans._tcp.local", 16, txt), rr("acme.local", 1, Buffer.from([192, 168, 1, 40]))]);
	const recs = parseDns(msg);
	assert.deepEqual(recs.map((r) => r.type), [12, 33, 16, 1]);
	assert.equal(recs[0].data, "Acme._uscans._tcp.local");
	assert.deepEqual(recs[1].data, { port: 443, target: "acme.local" });
	assert.deepEqual(recs[2].data, { rs: "eSCL", ty: "Acme 9" });
	assert.equal(recs[3].data, "192.168.1.40");
});

test("email: documents worth importing, keyword filter, own mail", () => {
	const email = parseEmail(sampleEmail());
	const docs = emailDocuments(email, 25 << 20);
	assert.equal(docs.length, 1);
	assert.equal(docs[0].type, "application/pdf");
	assert.ok(looksLikeBill(email, ["amount due"]));
	assert.ok(!looksLikeBill(email, ["mortgage"]));
	assert.ok(looksLikeBill(email, []));
	// logos are skipped, photos kept, odd names cleaned
	const fake = { attachments: [
		{ filename: "logo.png", contentType: "image/png", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500)]) },
		{ filename: "", contentType: "image/jpeg", data: Buffer.concat([JPEG, Buffer.alloc(30_000)]) },
		{ filename: "a/b.csv", contentType: "text/csv", data: Buffer.from("Date,Amount\n") },
		{ filename: "huge.pdf", contentType: "application/pdf", data: Buffer.alloc(200) },
	] };
	const d2 = emailDocuments(fake, 100);
	assert.deepEqual(d2.map((d) => d.name), ["a-b.csv"]);
	assert.deepEqual(emailDocuments(fake, 1 << 20).map((d) => d.name), ["photo.jpg", "a-b.csv", "huge.pdf"]);
	assert.ok(sentByMe({ labels: ["SENT"] }));
	assert.ok(sentByMe({ from: "me@x.com", to: "them@y.com" }, "me@x.com"));
	assert.ok(!sentByMe({ from: "me@x.com", to: "me@x.com" }, "me@x.com"));
	assert.equal(gmailQuery({ lookbackDays: 7, keywords: ["bill", "amount due"], custom: "" }), 'newer_than:7d -in:drafts -in:chats {bill "amount due"}');
});
