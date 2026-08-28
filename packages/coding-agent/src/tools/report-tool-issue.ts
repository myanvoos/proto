import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { $env, $flag, getAutoQaDbPath, getInstallId, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "..";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";

export const REPORT_ISSUE_DEVICE_NAME = "report_issue";
const REPORT_ISSUE_DEVICE_PATH = `xd://${REPORT_ISSUE_DEVICE_NAME}`;

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

function parseReportIssueBody(text: string): { tool: string; report: string } {
	const body = text.trim();
	if (!body) {
		throw new ToolError(`Empty report. ${reportIssueDeviceUsage()}`);
	}
	const firstNewline = body.indexOf("\n");
	if (firstNewline >= 0) {
		const tool = body.slice(0, firstNewline).trim();
		const report = body.slice(firstNewline + 1).trim();
		if (tool && report) return { tool, report };
	}
	const colon = body.indexOf(":");
	if (colon > 0) {
		const tool = body.slice(0, colon).trim();
		const report = body.slice(colon + 1).trim();
		if (tool && report) return { tool, report };
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

export function __resetAutoQaConsentForTests(): void {
	consentHandler = null;
	persistentConsentSettings = null;
	cachedConsent = null;
	consentInFlight = null;
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
		db.exec(`
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				pushed INTEGER NOT NULL DEFAULT 0
			);
		`);

		const hasCreatedAt = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'created_at'").get();
		if (!hasCreatedAt) {
			db.exec(`
				ALTER TABLE grievances ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
				UPDATE grievances SET created_at = CURRENT_TIMESTAMP WHERE created_at = '';
			`);
		}
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

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

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
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) return { pushed: totalPushed, ok: true };

		const body = JSON.stringify({
			agent: { name: "proto", version: VERSION },
			installId: getInstallId(),

			platform: process.platform,
			arch: process.arch,
			entries: rows,
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
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: String(error),
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		if (!response.ok) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				status: response.status,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			return { pushed: totalPushed, ok: false };
		}

		const ids = rows.map(r => r.id);
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
		totalPushed += rows.length;
		options.onProgress?.(totalPushed);
	}
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

let lastRecordPipeline: Promise<void> = Promise.resolve();

export function __awaitAutoQaRecordPipelineForTests(): Promise<void> {
	return lastRecordPipeline;
}

function recordToolIssue(session: ToolSession, tool: string, report: string): void {
	const canonicalTool = tool.startsWith("proxy_") ? tool.slice("proxy_".length) : tool;
	const model = session.getActiveModelString?.() ?? "unknown";
	lastRecordPipeline = (async () => {
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
