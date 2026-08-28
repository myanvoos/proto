import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPromise } from "node:util/types";
import { getLogsDir } from "./dirs";
import { RotatingFileSink } from "./logger/rotating-file";
import { drainModuleLoadEvents } from "./timing-buffer";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogEvent {
	readonly level: LogLevel;
	readonly message: string;
	readonly context: Record<string, unknown> | undefined;
	readonly timestamp: Date;
}

export type LogSink = (event: LogEvent) => void;

const logSinks = new Set<LogSink>();

export function registerLogSink(sink: LogSink): () => void {
	logSinks.add(sink);
	return () => {
		logSinks.delete(sink);
	};
}

function emitToSinks(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	if (logSinks.size === 0) return;
	const event: LogEvent = { level, message, context, timestamp: new Date() };
	for (const sink of logSinks) {
		try {
			sink(event);
		} catch {}
	}
}

const PROCESS_LOG_PATTERN = /^proto\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log(?:\.(\d+))?$/;
const PROCESS_AUDIT_PATTERN = /^\.proto\.(\d+)-audit\.json$/;
const RETAINED_STALE_LOGS_PER_PROCESS_DAY = 1;
const RETAINED_STALE_AUDIT_FILES = 0;
const RETAINED_STALE_LOG_DAYS = 5;

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EINVAL"));
	}
}

function pruneStaleProcessLogs(dir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const current = new Date();
	const currentDate =
		`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-` +
		String(current.getDate()).padStart(2, "0");
	const cutoff = new Date(current);
	cutoff.setDate(cutoff.getDate() - (RETAINED_STALE_LOG_DAYS - 1));
	const cutoffDate =
		`${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-` +
		String(cutoff.getDate()).padStart(2, "0");

	const staleLogsByProcessDay = new Map<string, Array<{ path: string; rollover: number }>>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const logMatch = PROCESS_LOG_PATTERN.exec(entry.name);
		const auditMatch = PROCESS_AUDIT_PATTERN.exec(entry.name);
		const pidText = logMatch?.[2] ?? auditMatch?.[1];
		if (!pidText || processIsRunning(Number(pidText))) continue;
		const entryPath = path.join(dir, entry.name);

		if (auditMatch) {
			if (RETAINED_STALE_AUDIT_FILES === 0) {
				try {
					fs.rmSync(entryPath, { force: true });
				} catch {}
			}
			continue;
		}
		if (!logMatch?.[1]) continue;
		if (logMatch[1] < cutoffDate || logMatch[1] > currentDate) {
			try {
				fs.rmSync(entryPath, { force: true });
			} catch {}
			continue;
		}

		const key = `${pidText}:${logMatch[1]}`;
		const staleLogs = staleLogsByProcessDay.get(key) ?? [];
		staleLogs.push({
			path: entryPath,
			rollover: Number(logMatch[3] ?? 0),
		});
		staleLogsByProcessDay.set(key, staleLogs);
	}

	for (const staleLogs of staleLogsByProcessDay.values()) {
		if (staleLogs.length <= RETAINED_STALE_LOGS_PER_PROCESS_DAY) continue;
		const ranked: Array<{ path: string; mtimeMs: number; rollover: number }> = [];
		for (const stale of staleLogs) {
			try {
				ranked.push({ ...stale, mtimeMs: fs.statSync(stale.path).mtimeMs });
			} catch {}
		}
		ranked.sort(
			(a, b) => b.mtimeMs - a.mtimeMs || b.rollover - a.rollover || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
		for (const stale of ranked.slice(RETAINED_STALE_LOGS_PER_PROCESS_DAY)) {
			try {
				fs.rmSync(stale.path, { force: true });
			} catch {}
		}
	}
}

function ensureDir(dir: string): string {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		const out: Record<string, unknown> = {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};

		const errAsRecord = value as unknown as Record<string, unknown>;
		for (const k in errAsRecord) out[k] = errAsRecord[k];
		if (value.cause !== undefined) out.cause = value.cause;
		return out;
	}
	return value;
}

interface NormalizedLogInfo extends Record<string, unknown> {
	level: LogLevel;
	message: unknown;
}

function padTimestampPart(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

function formatLocalTimestamp(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	return (
		`${padTimestampPart(date.getFullYear(), 4)}-${padTimestampPart(date.getMonth() + 1)}-${padTimestampPart(date.getDate())}` +
		`T${padTimestampPart(date.getHours())}:${padTimestampPart(date.getMinutes())}:${padTimestampPart(date.getSeconds())}` +
		`.${padTimestampPart(date.getMilliseconds(), 3)}${offsetSign}${padTimestampPart(Math.floor(absoluteOffset / 60))}` +
		`:${padTimestampPart(absoluteOffset % 60)}`
	);
}

const FORMAT_TOKEN_PATTERN = /%[scdjifoO%]/;

function normalizeLogInfo(
	level: LogLevel,
	message: string,
	context: Record<string, unknown> | undefined,
): NormalizedLogInfo {
	const metadata =
		!FORMAT_TOKEN_PATTERN.test(message) && context !== null && typeof context === "object" ? context : undefined;
	const info = Object.assign({}, metadata, { level, message }) as NormalizedLogInfo;
	if (metadata?.message) info.message = `${message} ${metadata.message}`;
	if (metadata?.stack) info.stack = metadata.stack;
	if (metadata?.cause) info.cause = metadata.cause;
	return info;
}

function formatLogInfo(info: NormalizedLogInfo): string {
	const timestamp = formatLocalTimestamp(new Date());
	info.timestamp = timestamp;
	const entry: Record<string, unknown> = {
		timestamp,
		level: info.level,
		pid: process.pid,
		message: info.message,
	};
	for (const [key, value] of Object.entries(info)) {
		if (key !== "level" && key !== "timestamp" && key !== "message") entry[key] = value;
	}
	return JSON.stringify(entry, jsonReplacer) as string;
}

function makeFileTransport(dir?: string): RotatingFileSink {
	const logsDir = ensureDir(dir ?? getLogsDir());
	pruneStaleProcessLogs(logsDir);
	return new RotatingFileSink({
		directory: logsDir,
		filenamePrefix: "proto",
		filenameSuffix: String(process.pid),
		maxBytes: 10 * 1024 * 1024,
		maxFiles: 5,
		auditFile: path.join(logsDir, `.proto.${process.pid}-audit.json`),
	});
}

let transportOpts: { console?: boolean; file?: boolean | string } = { file: true };

interface LocalTransports {
	readonly file: RotatingFileSink | undefined;
	readonly console: boolean;
}

let activeTransports: LocalTransports | undefined;

function buildTransports(opts: { console?: boolean; file?: boolean | string }): LocalTransports {
	return {
		file: opts.file ? makeFileTransport(typeof opts.file === "string" ? opts.file : undefined) : undefined,
		console: opts.console === true,
	};
}

function getLocalTransports(): LocalTransports {
	activeTransports ??= buildTransports(transportOpts);
	return activeTransports;
}

function emitLocally(level: LogLevel, message: string, context: Record<string, unknown> | undefined): void {
	const transports = getLocalTransports();
	const info = normalizeLogInfo(level, message, context);
	if (!transports.file && !transports.console) return;

	const line = formatLogInfo(info);
	if (transports.file) transports.file.write(line);
	if (transports.console) fs.writeSync(1, `${formatLogInfo(info)}${os.EOL}`);
}

export function setTransports(opts: { console?: boolean; file?: boolean | string }): void {
	transportOpts = opts;
	if (!activeTransports) return;
	const previousTransports = activeTransports;
	activeTransports = { file: undefined, console: false };
	previousTransports.file?.close();
	activeTransports = buildTransports(opts);
}

export function error(message: string, context?: Record<string, unknown>): void {
	try {
		emitLocally("error", message, context);
	} catch {}
	emitToSinks("error", message, context);
}

export function warn(message: string, context?: Record<string, unknown>): void {
	try {
		emitLocally("warn", message, context);
	} catch {}
	emitToSinks("warn", message, context);
}

export function info(message: string, context?: Record<string, unknown>): void {
	try {
		emitLocally("info", message, context);
	} catch {}
	emitToSinks("info", message, context);
}

export function debug(message: string, context?: Record<string, unknown>): void {
	try {
		emitLocally("debug", message, context);
	} catch {}
	emitToSinks("debug", message, context);
}

export function startupMarker(text: string): void {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {}
}

const LOGGED_TIMING_THRESHOLD_MS = 0.5;

interface Span {
	op: string;
	start: number;
	end?: number;
	parent?: Span;
	children: Span[];

	point?: boolean;

	modulePath?: string;

	moduleBodyMs?: number;

	moduleImports?: string[];
}
const spanStorage = new AsyncLocalStorage<Span>();
let gRootSpan: Span | undefined;
let gRecordTimings = false;

export function timingModeIncludes(option: "full" | "x"): boolean {
	const value = process.env.PI_TIMING;
	if (!value) return false;
	if (value === option) return true;
	let start = 0;
	for (let i = 0; i <= value.length; i++) {
		const code = i === value.length ? 44 : value.charCodeAt(i);
		const separator = code === 44 || code === 58 || code === 59 || code === 43 || code <= 32;
		if (!separator) continue;
		if (i > start && value.slice(start, i) === option) return true;
		start = i + 1;
	}
	return false;
}

export function shouldExitAfterTimings(): boolean {
	return timingModeIncludes("x") || timingModeIncludes("full");
}

export function printTimings(): void {
	if (!gRecordTimings || !gRootSpan) {
		console.error("\n--- Startup Timings ---\n(no markers)\n");
		return;
	}

	gRootSpan.end = performance.now();

	spliceModuleLoadBuffer();
	const lines: string[] = [];
	lines.push("");
	lines.push("--- Startup timings (hierarchical) ---");

	if (gRootSpan.start > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(before instrumentation): ${fmtMs(gRootSpan.start)} [runtime init + module load]`);
	}
	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of gRootSpan.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, 0, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, 0, lines);
	}

	const rootSelf = selfTimeOf(gRootSpan);
	if (gRootSpan.children.length > 0 && rootSelf > LOGGED_TIMING_THRESHOLD_MS) {
		lines.push(`(unattributed self): ${fmtMs(rootSelf)}`);
	}
	const totalMs = (gRootSpan.end - gRootSpan.start).toFixed(1);
	lines.push(`Total: ${totalMs}ms (since first marker)`);
	lines.push("--------------------------------------");
	lines.push("");
	console.error(lines.join("\n"));
	gRootSpan.end = undefined;
}

export function startTiming(): void {
	if (gRecordTimings) return;
	gRootSpan = {
		op: "(root)",
		start: performance.now(),
		parent: undefined,
		children: [],
	};
	gRecordTimings = true;
}

export function recordModuleLoadSpan(
	path: string,
	start: number,
	durationMs: number,
	bodyMs?: number,
	imports: string[] = [],
): void {
	if (!gRecordTimings || !gRootSpan) return;
	const parent = spanStorage.getStore() ?? gRootSpan;
	const span: Span = {
		op: `load:${shortenLoadPath(path)}`,
		start,
		end: start + durationMs,
		parent,
		children: [],
		modulePath: path,
		moduleBodyMs: bodyMs,
		moduleImports: imports,
	};
	parent.children.push(span);
}

function spliceModuleLoadBuffer(): void {
	if (!gRootSpan) return;
	const events = drainModuleLoadEvents();
	if (events.length === 0) return;
	let earliest = gRootSpan.start;
	for (const event of events) {
		recordModuleLoadSpan(event.path, event.start, event.durationMs, event.bodyMs, event.imports);
		if (event.start < earliest) earliest = event.start;
	}
	gRootSpan.start = earliest;
}

function shortenLoadPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
	return p;
}

export function endTiming(): void {
	gRootSpan = undefined;
	gRecordTimings = false;
}

export function openSpanPath(): string[] {
	const ops: string[] = [];
	let node = gRootSpan;
	while (node) {
		let next: Span | undefined;
		for (let i = node.children.length - 1; i >= 0; i--) {
			if (node.children[i].end === undefined) {
				next = node.children[i];
				break;
			}
		}
		if (!next) break;
		ops.push(next.op);
		node = next;
	}
	return ops;
}

function durationOf(span: Span): number {
	if (span.point || span.end === undefined) return 0;
	return span.end - span.start;
}

function selfTimeOf(span: Span): number {
	const dur = durationOf(span);
	if (span.children.length === 0 || span.point) return dur;
	const intervals = span.children
		.filter(c => !c.point && c.end !== undefined)
		.map(c => [c.start, c.end as number] as const)
		.sort((a, b) => a[0] - b[0]);
	if (intervals.length === 0) return dur;
	let union = 0;
	let curStart = intervals[0][0];
	let curEnd = intervals[0][1];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			union += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	union += curEnd - curStart;
	return Math.max(0, dur - union);
}

function fmtMs(ms: number): string {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 100) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(0)}ms`;
}

const MODULE_LOAD_PREFIX = "load:";
const MODULE_LOAD_VERBOSE_TOP = 10;
const MODULE_TREE_MAX_DEPTH = 5;
const MODULE_TREE_ROOT_TOP = 5;
const MODULE_TREE_CHILD_TOP = 8;

interface ModuleTimingNode {
	span: Span;
	children: ModuleTimingNode[];
	parents: number;
	body: number;
}

function isModuleLoadSpan(span: Span): boolean {
	return span.op.startsWith(MODULE_LOAD_PREFIX);
}

function printSpan(span: Span, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	if (span.point) {
		lines.push(`${indent}• ${span.op}`);
		return;
	}
	const dur = durationOf(span);
	if (dur < LOGGED_TIMING_THRESHOLD_MS && span.children.length === 0) return;
	const parallel = isParallel(span);
	const tag = parallel ? " [parallel]" : "";
	const self = selfTimeOf(span);
	const selfStr = span.children.length > 0 && self > LOGGED_TIMING_THRESHOLD_MS ? ` (self ${fmtMs(self)})` : "";
	lines.push(`${indent}${span.op}: ${fmtMs(dur)}${selfStr}${tag}`);

	const work: Span[] = [];
	const loads: Span[] = [];
	for (const child of span.children) {
		if (isModuleLoadSpan(child)) loads.push(child);
		else work.push(child);
	}
	for (const child of work.sort((a, b) => a.start - b.start)) {
		printSpan(child, depth + 1, lines);
	}
	if (loads.length > 0) {
		printModuleLoadSummary(loads, depth + 1, lines);
	}
}

function printModuleLoadSummary(loads: Span[], depth: number, lines: string[]): void {
	const childIndent = "  ".repeat(depth);
	const grandIndent = "  ".repeat(depth + 1);
	let unionStart = Number.POSITIVE_INFINITY;
	let unionEnd = 0;
	for (const span of loads) {
		if (span.end === undefined) continue;
		if (span.start < unionStart) unionStart = span.start;
		if (span.end > unionEnd) unionEnd = span.end;
	}
	const wall = unionEnd > unionStart ? unionEnd - unionStart : 0;
	const nodes = buildModuleTimingGraph(loads);
	lines.push(`${childIndent}(modules): ${loads.length} loaded, wall ${fmtMs(wall)}`);
	if (nodes.length === 0) return;

	const showAll = timingModeIncludes("full");
	const byBody = [...nodes].sort(compareModuleNodes);
	const topBody = showAll ? byBody : byBody.slice(0, MODULE_LOAD_VERBOSE_TOP);
	lines.push(`${grandIndent}top body/TLA:`);
	for (const node of topBody) {
		if (!showAll && node.body < LOGGED_TIMING_THRESHOLD_MS) break;
		lines.push(`${grandIndent}  ${node.span.op}: body ${fmtMs(node.body)} (total ${fmtMs(durationOf(node.span))})`);
	}
	if (!showAll && byBody.length > MODULE_LOAD_VERBOSE_TOP) {
		lines.push(`${grandIndent}  … ${byBody.length - MODULE_LOAD_VERBOSE_TOP} more (PI_TIMING=full to show all)`);
	}

	const roots = nodes.filter(node => node.parents === 0);
	const treeRoots = (roots.length > 0 ? roots : nodes).sort((a, b) => durationOf(b.span) - durationOf(a.span));
	const visibleRoots = showAll ? treeRoots : treeRoots.slice(0, MODULE_TREE_ROOT_TOP);
	lines.push(`${grandIndent}tree:`);
	const rendered = new Set<string>();
	for (const node of visibleRoots) {
		renderModuleTimingNode(node, depth + 2, lines, rendered, new Set<string>(), showAll);
	}
	if (!showAll && treeRoots.length > MODULE_TREE_ROOT_TOP) {
		lines.push(
			`${grandIndent}  … ${treeRoots.length - MODULE_TREE_ROOT_TOP} more roots (PI_TIMING=full to show all)`,
		);
	}
}

function buildModuleTimingGraph(loads: Span[]): ModuleTimingNode[] {
	const nodes = new Map<string, ModuleTimingNode>();
	for (const span of loads) {
		if (!span.modulePath || span.end === undefined) continue;
		nodes.set(span.modulePath, { span, children: [], parents: 0, body: span.moduleBodyMs ?? 0 });
	}
	for (const node of nodes.values()) {
		for (const childPath of node.span.moduleImports ?? []) {
			const child = nodes.get(childPath);
			if (!child || child === node) continue;
			node.children.push(child);
			child.parents++;
		}
	}
	for (const node of nodes.values()) {
		node.children.sort(compareModuleNodes);
	}
	return [...nodes.values()];
}

function compareModuleNodes(a: ModuleTimingNode, b: ModuleTimingNode): number {
	const bodyDiff = b.body - a.body;
	if (Math.abs(bodyDiff) > 0.001) return bodyDiff;
	return durationOf(b.span) - durationOf(a.span);
}

function renderModuleTimingNode(
	node: ModuleTimingNode,
	depth: number,
	lines: string[],
	rendered: Set<string>,
	ancestors: Set<string>,
	showAll: boolean,
): void {
	const path = node.span.modulePath;
	if (!path) return;
	const indent = "  ".repeat(depth);
	const total = durationOf(node.span);
	if (!showAll && total < LOGGED_TIMING_THRESHOLD_MS && node.children.length === 0) return;
	const wait = Math.max(0, total - node.body);
	const shared = node.parents > 1 ? " [shared]" : "";
	const timing =
		node.body > LOGGED_TIMING_THRESHOLD_MS || node.children.length > 0
			? ` (body ${fmtMs(node.body)}, wait ${fmtMs(wait)})`
			: "";
	const alreadyRendered = rendered.has(path);
	const cycle = ancestors.has(path);
	const suffix = cycle ? " [cycle]" : alreadyRendered ? " [already shown]" : "";
	lines.push(`${indent}${node.span.op}: ${fmtMs(total)}${timing}${shared}${suffix}`);
	if (cycle || alreadyRendered) return;
	rendered.add(path);
	ancestors.add(path);
	if (!showAll && ancestors.size >= MODULE_TREE_MAX_DEPTH) {
		if (node.children.length > 0) {
			lines.push(`${indent}  … ${node.children.length} imports deeper (PI_TIMING=full to show all)`);
		}
		ancestors.delete(path);
		return;
	}
	const visibleChildren = showAll ? node.children : node.children.slice(0, MODULE_TREE_CHILD_TOP);
	for (const child of visibleChildren) {
		renderModuleTimingNode(child, depth + 1, lines, rendered, ancestors, showAll);
	}
	if (!showAll && node.children.length > MODULE_TREE_CHILD_TOP) {
		lines.push(
			`${indent}  … ${node.children.length - MODULE_TREE_CHILD_TOP} more imports (PI_TIMING=full to show all)`,
		);
	}
	ancestors.delete(path);
}

function isParallel(span: Span): boolean {
	const parent = span.parent;
	if (!parent || span.end === undefined) return false;
	for (const sibling of parent.children) {
		if (sibling === span || sibling.end === undefined || sibling.point) continue;

		if (sibling.start < span.end && span.start < sibling.end) return true;
	}
	return false;
}

export function time(op: string): void;
export function time<T, A extends unknown[]>(op: string, fn: (...args: A) => T, ...args: A): T;
export function time<T, A extends unknown[]>(op: string, fn?: (...args: A) => T, ...args: A): T | undefined {
	const recording = gRecordTimings && gRootSpan !== undefined;

	if (fn === undefined) {
		startupMarker(op);
		if (!recording) return undefined as T;
		const parent = spanStorage.getStore() ?? gRootSpan!;
		const now = performance.now();
		parent.children.push({ op, start: now, end: now, parent, children: [], point: true });
		return undefined as T;
	}

	if (!recording && !process.env.PI_DEBUG_STARTUP) {
		return fn(...args);
	}

	startupMarker(`${op}:start`);
	let span: Span | undefined;
	if (recording) {
		const parent = spanStorage.getStore() ?? gRootSpan!;
		span = { op, start: performance.now(), parent, children: [] };
		parent.children.push(span);
	}

	const finish = (ok: boolean): void => {
		if (span) span.end = performance.now();
		startupMarker(ok ? `${op}:done` : `${op}:fail`);
	};
	try {
		const result = span ? spanStorage.run(span, () => fn(...args)) : fn(...args);
		if (isPromise(result)) {
			return result.then(
				value => {
					finish(true);
					return value;
				},
				error => {
					finish(false);
					throw error;
				},
			) as T;
		}
		finish(true);
		return result;
	} catch (error) {
		finish(false);
		throw error;
	}
}
