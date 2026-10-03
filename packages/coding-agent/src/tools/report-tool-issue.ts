import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { $env, $flag, getAutoQaDbPath, getInstallId, logger, truncateHeadBytes, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "..";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui/status-line";
import { truncateToWidth } from "../tui/utils";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";

export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
const REPORT_ISSUE_DEVICE_PATH = `protolens://${REPORT_ISSUE_DEVICE_NAME}`;

export function reportIssueDeviceUsage(): string {
	return `Write \`<tool>: <concise description>\` as plain text to ${REPORT_ISSUE_DEVICE_PATH}. A two-line fallback also works: tool name on line 1, report body below.`;
}

export function renderReportIssueDeviceCall(content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const text = renderStatusLine(
		{
			icon: "pending",
			title: "Report Tool Issue",
			description: body ? truncateToWidth(body, 72) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

/**
 * Collector limit for `tool`, in UTF-8 bytes. One oversized entry makes it reject the whole batch with HTTP 400, so
 * grievances are clamped at record time and again at send time (older rows still sit in users' databases).
 */
const MAX_TOOL_BYTES = 128;

/** An over-long `tool` is prose put on line 1: keep it at the head of the report and truncate only the name. */
function clampGrievance(tool: string, report: string): { tool: string; report: string } {
	if (Buffer.byteLength(tool, "utf8") <= MAX_TOOL_BYTES) return { tool, report };
	return { tool: truncateHeadBytes(tool, MAX_TOOL_BYTES).text, report: `${tool}\n${report}` };
}

function parseReportIssueBody(text: string): { tool: string; report: string } {
	const body = text.trim();
	if (!body) {
		throw new ToolError(`Empty report. ${reportIssueDeviceUsage()}`);
	}
	const firstNewline = body.indexOf("\n");
	if (firstNewline >= 0) {
		const tool = body.slice(0, firstNewline).trim();
		const report = body.slice(firstNewline + 1).trim();
		if (tool && report) return clampGrievance(tool, report);
	}
	const colon = body.indexOf(":");
	if (colon > 0) {
		const tool = body.slice(0, colon).trim();
		const report = body.slice(colon + 1).trim();
		if (tool && report) return clampGrievance(tool, report);
	}
	throw new ToolError(`Invalid report format. ${reportIssueDeviceUsage()}`);
}

export function isAutoQaEnabled(settings?: Settings): boolean {
	let fallback = false;
	if (settings) {
		const enabled = !!settings.get("dev.autoqa");
		fallback = settings.isConfigured("dev.autoqa")
			? enabled
			: enabled && settings.get("dev.autoqaConsent") !== "denied";
	}
	return $flag("PI_AUTO_QA", fallback);
}

type AutoQaConsentHandler = () => Promise<boolean | null>;

let consentHandler: AutoQaConsentHandler | null = null;

let persistentConsentSettings: Settings | null = null;

let cachedConsent: boolean | null = null;

let consentInFlight: Promise<boolean> | null = null;

export function setAutoQaConsentHandler(
	handler: AutoQaConsentHandler | null,
	persistentSettings: Settings | null = null,
): void {
	consentHandler = handler;
	persistentConsentSettings = persistentSettings;
}

function readPersistedConsent(settings: Settings | undefined): boolean | null {
	if (!settings) return null;
	const stored = settings.get("dev.autoqaConsent");
	if (stored === "granted") return true;
	if (stored === "denied") return false;
	return null;
}

function persistConsent(localSettings: Settings | undefined, granted: boolean): void {
	const value = granted ? "granted" : "denied";
	try {
		localSettings?.set("dev.autoqaConsent", value);
	} catch (error) {
		logger.warn("Failed to persist auto-QA consent to local settings snapshot", { error: String(error) });
	}
	if (persistentConsentSettings && persistentConsentSettings !== localSettings) {
		try {
			persistentConsentSettings.set("dev.autoqaConsent", value);
		} catch (error) {
			logger.warn("Failed to persist auto-QA consent to persistent settings", { error: String(error) });
		}
	}
}

export async function resolveAutoQaConsent(settings: Settings | undefined): Promise<boolean> {
	if (cachedConsent !== null) return cachedConsent;
	const localPersisted = readPersistedConsent(settings);
	if (localPersisted !== null) {
		cachedConsent = localPersisted;
		return localPersisted;
	}
	const globalPersisted =
		persistentConsentSettings && persistentConsentSettings !== settings
			? readPersistedConsent(persistentConsentSettings)
			: null;
	if (globalPersisted !== null) {
		cachedConsent = globalPersisted;
		return globalPersisted;
	}
	if (!consentHandler) return false;
	if (consentInFlight) return consentInFlight;
	consentInFlight = (async () => {
		try {
			const result = await consentHandler!();
			if (result === null) return false;
			cachedConsent = result;
			persistConsent(settings, result);
			return result;
		} catch {
			return false;
		} finally {
			consentInFlight = null;
		}
	})();
	return consentInFlight;
}

let cachedDb: Database | null = null;

export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	const dbPath = getAutoQaDbPath();
	if (!dbPath) return null;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true });

		db.run("PRAGMA busy_timeout = 5000");
		// `pushed`: 0 = queued, 1 = accepted, -1 = permanently refused (`push_error` holds the collector's reason).
		db.exec(`
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				pushed INTEGER NOT NULL DEFAULT 0,
				push_error TEXT
			);
		`);

		const hasCreatedAt = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'created_at'").get();
		if (!hasCreatedAt) {
			db.exec(`
				ALTER TABLE grievances ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
				UPDATE grievances SET created_at = CURRENT_TIMESTAMP WHERE created_at = '';
			`);
		}
		const hasPushError = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'push_error'").get();
		if (!hasPushError) db.exec("ALTER TABLE grievances ADD COLUMN push_error TEXT;");
		db.exec(`
			CREATE INDEX IF NOT EXISTS grievances_pushed_created_at_idx
			ON grievances (pushed, created_at, id);
		`);
		cachedDb = db;
		return db;
	} catch (error) {
		logger.warn("Failed to open auto-QA database", { error: String(error) });
		return null;
	}
}

export interface FlushResult {
	pushed: number;
	ok: boolean;
	skipped?: boolean;
	/** Rows the collector permanently refused, parked as `pushed = -1`; present only when non-zero. */
	rejected?: number;
	/** Last collector error (`HTTP <status>: <body>`). */
	error?: string;
}

interface FlushOptions {
	bypassConsent?: boolean;

	fetch?: FetchImpl;

	onStart?: (totalUnpushed: number) => void;

	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;

const FLUSH_BATCH_SIZE = 50;
const MAX_PUSH_ERROR_CHARS = 300;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!isAutoQaEnabled(settings)) return null;

	if (!bypassConsent) {
		const consented = settings?.get("dev.autoqaConsent") === "granted";
		if (!consented && !$flag("PI_AUTO_QA_PUSH")) return null;
	}

	const endpoint = envOverrideString("PI_AUTO_QA_PUSH_URL") ?? settings?.get("dev.autoqaPush.endpoint");
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token = envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? settings?.get("dev.autoqaPush.token");
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
}

async function describeErrorResponse(response: Response): Promise<string> {
	let detail = "";
	try {
		detail = (await response.text()).trim();
	} catch {}
	if (detail.length > MAX_PUSH_ERROR_CHARS) detail = `${detail.slice(0, MAX_PUSH_ERROR_CHARS)}…`;
	return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}

type BatchOutcome = { kind: "sent" } | { kind: "rejected"; error: string } | { kind: "retry"; error: string };

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);

	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	let totalRejected = 0;
	let lastError: string | undefined;

	const postBatch = async (batch: GrievanceRow[]): Promise<BatchOutcome> => {
		const body = JSON.stringify({
			agent: { name: "proto", version: VERSION },
			installId: getInstallId(),

			platform: process.platform,
			arch: process.arch,
			entries: batch.map(row => ({ ...row, ...clampGrievance(row.tool, row.report) })),
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			return { kind: "retry", error: String(error) };
		}
		if (response.ok) return { kind: "sent" };
		const error = await describeErrorResponse(response);
		// 400/413/422 refuse the payload itself, so resending the same bytes can only fail again; 5xx, 408, 429 and
		// auth failures say nothing about the rows and stay retryable.
		const permanent = response.status === 400 || response.status === 413 || response.status === 422;
		return permanent ? { kind: "rejected", error } : { kind: "retry", error };
	};

	// Bisects refused batches until the offending rows are isolated and parked; false = transient failure.
	const shipBatch = async (batch: GrievanceRow[]): Promise<boolean> => {
		const outcome = await postBatch(batch);
		if (outcome.kind === "sent") {
			const ids = batch.map(r => r.id);
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
			totalPushed += batch.length;
			options.onProgress?.(totalPushed);
			return true;
		}
		lastError = outcome.error;
		if (outcome.kind === "retry") return false;
		if (batch.length === 1) {
			const row = batch[0]!;
			db.prepare("UPDATE grievances SET pushed = -1, push_error = ? WHERE id = ?").run(outcome.error, row.id);
			totalRejected += 1;
			logger.warn("autoqa grievance rejected", {
				endpoint: config.endpoint,
				id: row.id,
				tool: row.tool,
				error: outcome.error,
			});
			return true;
		}
		const mid = Math.floor(batch.length / 2);
		return (await shipBatch(batch.slice(0, mid))) && (await shipBatch(batch.slice(mid)));
	};

	let ok = true;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) break;
		if (!(await shipBatch(rows))) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: lastError,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			ok = false;
			break;
		}
	}
	return {
		pushed: totalPushed,
		ok,
		...(totalRejected > 0 ? { rejected: totalRejected } : {}),
		...(lastError ? { error: lastError } : {}),
	};
}

export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	const bypass = options.bypassConsent === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

function recordToolIssue(session: ToolSession, tool: string, report: string): void {
	const canonicalTool = tool.startsWith("proxy_") ? tool.slice("proxy_".length) : tool;
	const model = session.getActiveModelString?.() ?? "unknown";
	void (async () => {
		try {
			if (!$flag("PI_AUTO_QA_PUSH") && !(await resolveAutoQaConsent(session.settings))) return;
			const db = openAutoQaDb();
			if (!db) return;
			db.prepare(
				"INSERT INTO grievances (model, version, tool, report, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
			).run(model, VERSION, canonicalTool, report);
			await flushGrievances(db, session.settings);
		} catch (error) {
			logger.debug("autoqa consent pipeline failed", { error: String(error) });
		}
	})();
}

export async function dispatchReportIssueDevice(
	session: ToolSession,
	text: string,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	try {
		if (isAutoQaEnabled(session.settings)) {
			const { tool, report } = parseReportIssueBody(text);
			recordToolIssue(session, tool, report);
		}
	} catch (error) {
		if (error instanceof ToolError) throw error;
		logger.error("Failed to record tool issue", { error });
	}
	return {
		result: { content: [{ type: "text", text: "Noted, thanks!" }] },
		xdev: { tool: REPORT_ISSUE_DEVICE_NAME, mode: "execute", args: { report: text.trim() } },
	};
}
