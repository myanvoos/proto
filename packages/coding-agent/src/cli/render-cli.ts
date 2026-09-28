import { Database } from "bun:sqlite";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import { formatBytes, getProjectDir, isEnoent, logger, TempDir } from "@oh-my-pi/pi-utils";
import { detectColorLevel } from "@oh-my-pi/pi-utils/chalk";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { LocalProtocolHandler } from "../internal-urls/local-protocol";
import { Composer } from "../modes/composer";
import { InteractiveMode } from "../modes/interactive-mode";
import { initTheme } from "../modes/theme/theme";
import { TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_MESSAGES } from "../modes/utils/transcript-window";
import { AgentSession } from "../session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "../session/auth-storage";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { sessionArchivePath } from "../session/session-loader";
import { artifactsDirectoryFor, SessionManager } from "../session/session-manager";

interface RenderCommandArgs {
	session?: string;

	width?: number;

	height?: number;

	timing?: boolean;

	repaint?: number;

	plain?: boolean;

	quiet?: boolean;
}

class SinkTerminal implements Terminal {
	bytes = 0;
	writes = 0;
	readonly #columns: number;
	readonly #rows: number;

	constructor(columns: number, rows: number) {
		this.#columns = columns;
		this.#rows = rows;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += Buffer.byteLength(data);
		this.writes++;
	}
	get columns(): number {
		return this.#columns;
	}
	get rows(): number {
		return this.#rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	refreshAppearance(_requestToken?: TerminalAppearanceRequestToken): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

class DrainScheduler implements RenderScheduler {
	#time = 0;
	#immediate: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
		return { cancel: () => void this.#renders.delete(id) };
	}

	drain(): void {
		for (let rounds = 0; this.#immediate.length > 0 || this.#renders.size > 0; rounds++) {
			if (rounds > 100) throw new Error("render scheduler did not settle after 100 drain rounds");
			const immediate = this.#immediate;
			this.#immediate = [];
			for (const callback of immediate) callback();
			if (this.#renders.size === 0) continue;
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const callback of renders) callback();
		}
	}
}

async function resolveTargetSession(sessionArg: string | undefined, cwd: string): Promise<string> {
	if (sessionArg) {
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const resolved = path.resolve(sessionArg);
			try {
				await fs.access(resolved);
				return resolved;
			} catch (err) {
				if (isEnoent(err)) throw new CliUsageError(`Session file not found: ${resolved}`);
				throw err;
			}
		}
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new CliUsageError(`Session "${sessionArg}" not found.`);
		return match.session.path;
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd));
	if (!recent) throw new CliUsageError(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}

/** OSC 133 prompt markers: `ESC ] 133 ; … BEL` or `ESC ] 133 ; … ESC \\`. */
const SHELL_INTEGRATION_MARKER = /\u001b\]133;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function formatMs(ms: number): string {
	return `${ms.toFixed(0)} ms`;
}

export async function runRenderCommand(args: RenderCommandArgs): Promise<number> {
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	await initTheme();

	const sourcePath = await resolveTargetSession(args.session, cwd);
	const sourceSize = (await fs.stat(sourcePath)).size;

	const tempDir = TempDir.createSync("@proto-render-");
	const workingCopy = path.join(tempDir.path(), path.basename(sourcePath));

	const width = args.width ?? (process.stdout.isTTY ? process.stdout.columns : undefined) ?? 120;
	const height = args.height ?? (process.stdout.isTTY ? process.stdout.rows : undefined) ?? 40;

	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let releaseLocalProtocol: (() => void) | undefined;
	try {
		await fs.copyFile(sourcePath, workingCopy);
		try {
			await fs.copyFile(sessionArchivePath(sourcePath), sessionArchivePath(workingCopy));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const openStart = performance.now();
		const sessionManager = await SessionManager.open(workingCopy, undefined, undefined, {
			suppressBreadcrumb: true,
		});
		const openMs = performance.now() - openStart;
		// The replay copy is disposable; clickable resources still belong to the source session.
		releaseLocalProtocol = LocalProtocolHandler.setOverride({
			getArtifactsDir: () => artifactsDirectoryFor(sourcePath),
			getSessionId: () => sessionManager.getSessionId(),
		});

		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.getAll()[0];
		if (!model) throw new Error("No models available in the bundled catalog");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry,
		});
		const terminal = new SinkTerminal(width, height);
		const scheduler = new DrainScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { quiet: true },
		});
		mode = new InteractiveMode(session, VERSION, undefined, undefined, undefined, undefined, composer);
		await mode.init();
		scheduler.drain();

		const replayStart = performance.now();
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		const replayMs = performance.now() - replayStart;

		const paintStart = performance.now();
		const bytesBeforePaint = terminal.bytes;
		scheduler.drain();
		const paintMs = performance.now() - paintStart;
		const paintBytes = terminal.bytes - bytesBeforePaint;

		const entryCount = sessionManager.getEntryCount();
		const messageCount = sessionManager.getEntryCount("message");

		const repaints: { ms: number; bytes: number }[] = [];
		for (let i = 0; i < (args.repaint ?? 0); i++) {
			const start = performance.now();
			const before = terminal.bytes;
			mode.ui.requestRender(true, { clearScrollback: true });
			scheduler.drain();
			repaints.push({ ms: performance.now() - start, bytes: terminal.bytes - before });
		}

		if (!args.quiet) {
			// Offline output keeps full chronological history, but admits and disposes
			// one durable page at a time instead of bypassing interactive byte limits.
			const stripStyling = args.plain === true || detectColorLevel(process.env, true) === 0;
			let pageFromLatest = Number.MAX_SAFE_INTEGER;
			while (true) {
				const context = session.buildTranscriptSessionContext({
					collapseCompactedHistory: false,
					window: { pageFromLatest, maxMessages: TRANSCRIPT_WINDOW_MESSAGES, maxBytes: TRANSCRIPT_WINDOW_BYTES },
				});
				mode.resetTranscript();
				mode.renderSessionContext(context);
				const joined = mode.chatContainer.render(width).join("\n");
				const text = stripStyling
					? Bun.stripANSI(joined)
					: process.stdout.isTTY
						? joined
						: joined.replace(SHELL_INTEGRATION_MARKER, "");
				if (!process.stdout.write(`${text}\n`)) await once(process.stdout, "drain");
				const page = context.window?.pageFromLatest ?? 0;
				if (page === 0) break;
				pageFromLatest = page - 1;
			}
		}

		if (args.timing || args.repaint) {
			const rows = mode.chatContainer.render(width).length;
			const report = [
				`session  ${sourcePath}`,
				`         ${formatBytes(sourceSize, { style: "spaced-iec" })}, ${entryCount} entries, ${messageCount} messages, ${rows} transcript rows @ ${width}x${height}`,
				`open     ${formatMs(openMs)}`,
				`replay   ${formatMs(replayMs)}  (transcript build + component construction)`,
				`paint    ${formatMs(paintMs)}  (full frame compose + emit: ${formatBytes(paintBytes, { style: "spaced-iec" })}, ${terminal.writes} writes)`,
			];
			if (repaints.length > 0) {
				const times = repaints.map(r => r.ms);
				const avg = times.reduce((a, b) => a + b, 0) / times.length;
				const min = Math.min(...times);
				const max = Math.max(...times);
				const bytesPer = repaints[0]!.bytes;
				report.push(
					`repaint  ${formatMs(avg)} avg over ${repaints.length} (min ${formatMs(min)}, max ${formatMs(max)}), ${formatBytes(bytesPer, { style: "spaced-iec" })}/frame`,
				);
			}
			process.stderr.write(`${report.join("\n")}\n`);
		}
		return 0;
	} finally {
		try {
			mode?.stop();
			await session?.dispose();
		} catch (err) {
			logger.debug("proto render teardown failed", { error: String(err) });
		}
		releaseLocalProtocol?.();
		tempDir.removeSync();
	}
}
