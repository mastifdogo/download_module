// Import (module id "downloads"), last version: Import is now part of Auto sort (module id
// "categorizer", mastifdogo/auto-sort_module). This version takes nothing in and changes nothing
// of its own. It only gets Import's data ready to be brought over:
//
//   - every file still in the module's own storage is filed in Ledger's Documents, so each
//     inbox row carries a document_id (lib/move.mjs);
//   - the page and the dashboard say what to do: update Auto sort, press "Bring over Import's
//     files" there (it reads mod_downloads.* itself), then remove this module.
//
// Ledger loads this file at startup and calls register(ctx); API: docs/MODULE_LLM_CONTEXT.md in
// the Ledger repository.

import { handoverState, startMoving } from "./lib/move.mjs";

const AUTO_SORT = "categorizer";
const AUTO_SORT_NEEDS = "0.17.0"; // the first Auto sort that brings Import's data over
const NOTICE_KEY = "moved-to-auto-sort";
const GONE = "Import is now part of Auto sort, and this Import no longer takes files. Update Auto sort under Settings → Modules, then install the new browser extension or phone app from the Auto sort page in Ledger and send the file again.";

/** @param {any} ctx */
export default async function register(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const mover = startMoving(ctx);

	// Whether Auto sort runs in this Ledger: it takes files from other modules, so it is among the targets.
	function autoSort() {
		try {
			const t = ctx.files.targets().find((x) => x.id === AUTO_SORT);
			return { installed: !!t, name: t?.name ?? "Auto sort", needs: AUTO_SORT_NEEDS };
		} catch {
			return { installed: false, name: "Auto sort", needs: AUTO_SORT_NEEDS };
		}
	}

	// GET /status: where the hand-over stands in this organization, for the page.
	ctx.route("GET", "/status", async (req) => {
		const state = await handoverState(ctx);
		const { rows } = await ctx.db.query(
			`SELECT (SELECT count(*)::int FROM ${T("extractions")}) AS extractions,
			        (SELECT count(*)::int FROM ${T("mail_seen")}) AS emails_seen,
			        (SELECT count(*)::int FROM ${T("mail_training")}) AS email_examples`,
		);
		// Something is left (a file that failed earlier, or a restore brought files back): try now, in the background.
		if (state.to_move + state.stray > 0 && !mover.running()) void mover.run();
		return {
			version: ctx.version,
			organization: req.user?.organization?.name ?? "",
			role: req.user?.role ?? "",
			...state,
			moving: mover.running(),
			also: { extractions: Number(rows[0]?.extractions ?? 0), emails_seen: Number(rows[0]?.emails_seen ?? 0), email_examples: Number(rows[0]?.email_examples ?? 0) },
			auto_sort: autoSort(),
		};
	});

	// What the old Send to Ledger extension and the old phone app call to send a file: a clear
	// answer they show as it is, instead of "not found".
	const gone = async () => {
		throw new ctx.HttpError(410, GONE, "gone");
	};
	ctx.route("POST", "/files", gone);
	ctx.route("PUT", "/files/:id/chunks/:index", gone);
	ctx.route("POST", "/files/:id/complete", gone);
	ctx.route("POST", "/files/:id/file-as", gone);

	// The dashboard, in every organization: one notice pointing at the page (the same text every
	// start, so one a person dismissed stays dismissed), and the old inbox items taken away.
	async function notices() {
		await ctx.dashboard.remove("inbox", "notification");
		await ctx.dashboard.remove("review");
		await ctx.dashboard.notify({
			key: NOTICE_KEY,
			title: "Import is now part of Auto sort",
			body: `Its files are being kept safe in Ledger's Documents. To finish: update Auto sort to ${AUTO_SORT_NEEDS} or newer, press "Bring over Import's files" on the Auto sort page, then remove Import under Settings → Modules.`,
			level: "warning",
			link: `/apps/${ctx.id}`,
		});
	}

	// Not awaited: register must return quickly, and the move can take a while.
	void (async () => {
		try {
			await ctx.orgs.forEach(async (org) => {
				await notices().catch((err) => ctx.log.warn("dashboard update failed", { org: String(org.id), err: String(err?.message || err) }));
			});
		} catch (err) {
			ctx.log.warn("dashboard update failed", { err: String(err?.message || err) });
		}
		const total = await mover.run();
		ctx.log.info("import hand-over: first pass done", total);
	})();

	ctx.log.info("import module ready (hand-over to Auto sort)");
}
