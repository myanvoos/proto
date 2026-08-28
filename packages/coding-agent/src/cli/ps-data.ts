import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	formatDuration,
	getDaemonRuntimeRoot,
	getGlobalDaemonRuntimeDir,
	getGlobalDaemonRuntimeRoot,
	getProjectDir,
	isEnoent,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../launch/client";
import { canonicalProjectDir, daemonRuntimeDir, readDaemonScopeMeta } from "../launch/paths";
import { readLiveDaemonBrokerPid } from "../launch/presence";
import {
	type DaemonSnapshot,
	type DaemonSpec,
	type DaemonState,
	parseDaemonSnapshot,
	parseDaemonSpec,
} from "../launch/protocol";

export interface PsScope {
	kind: "project" | "global";
	runtimeDir: string;

	projectDir?: string;

	service?: string;

	brokerPid?: number;
}

export interface PsDaemonRow {
	snapshot: DaemonSnapshot;

	command?: string;
	cwd?: string;

	supervised: boolean;
}

export interface PsScopeReport {
	scope: PsScope;
	daemons: PsDaemonRow[];
}

export interface PsTarget {
	dir?: string;
	global?: string;
}

const PROJECT_SCOPE_KEY = /^[0-9a-f]{16}$/;

export const KILL_GRACE_MS = 100;
export const TERMINAL_STATES: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

export async function targetScope(target: PsTarget): Promise<PsScope> {
	if (target.global) {
		const runtimeDir = await canonicalRuntimeDir(getGlobalDaemonRuntimeDir(target.global));
		return {
			kind: "global",
			runtimeDir,
			service: target.global,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		};
	}
	const projectDir = await canonicalProjectDir(target.dir ?? getProjectDir());
	const runtimeDir = daemonRuntimeDir(projectDir);
	return { kind: "project", runtimeDir, projectDir, brokerPid: await readLiveDaemonBrokerPid(runtimeDir) };
}

async function canonicalRuntimeDir(dir: string): Promise<string> {
	try {
		return await fs.realpath(dir);
	} catch {
		return path.resolve(dir);
	}
}

async function discoverScopes(): Promise<PsScope[]> {
	const scopes: PsScope[] = [];
	for (const entry of await readdirQuiet(getDaemonRuntimeRoot())) {
		if (!entry.isDirectory() || !PROJECT_SCOPE_KEY.test(entry.name)) continue;
		const runtimeDir = path.join(getDaemonRuntimeRoot(), entry.name);
		scopes.push({
			kind: "project",
			runtimeDir,
			projectDir: await resolveScopeProjectDir(runtimeDir),
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	for (const entry of await readdirQuiet(getGlobalDaemonRuntimeRoot())) {
		if (!entry.isDirectory()) continue;
		const runtimeDir = await canonicalRuntimeDir(path.join(getGlobalDaemonRuntimeRoot(), entry.name));
		scopes.push({
			kind: "global",
			runtimeDir,
			service: entry.name,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	return scopes;
}

async function readdirQuiet(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function resolveScopeProjectDir(runtimeDir: string): Promise<string | undefined> {
	const recorded = await readDaemonScopeMeta(runtimeDir);
	if (recorded) return recorded;
	for (const entry of await readdirQuiet(path.join(runtimeDir, "clients"))) {
		try {
			const decoded: unknown = await Bun.file(path.join(runtimeDir, "clients", entry.name)).json();
			if (
				typeof decoded === "object" &&
				decoded !== null &&
				"projectDir" in decoded &&
				typeof decoded.projectDir === "string"
			) {
				return decoded.projectDir;
			}
		} catch {}
	}
	return undefined;
}

export async function scopeClient(scope: PsScope): Promise<DaemonBrokerClient | undefined> {
	const connectDir = scope.projectDir ?? scope.runtimeDir;
	if (connectDir === undefined) return undefined;
	return createDaemonBrokerClient(connectDir, { runtimeDir: scope.runtimeDir });
}

async function readPersistedDaemons(
	runtimeDir: string,
): Promise<Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>> {
	const persisted = new Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>();
	const root = path.join(runtimeDir, "daemons");
	for (const entry of await readdirQuiet(root)) {
		if (!entry.isDirectory()) continue;
		try {
			const decoded: unknown = await Bun.file(path.join(root, entry.name, "meta.json")).json();
			if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded))
				continue;
			const snapshot = parseDaemonSnapshot(decoded.daemon);
			persisted.set(snapshot.name, { snapshot, spec: parseDaemonSpec(decoded.spec) });
		} catch {}
	}
	return persisted;
}

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function collectScope(scope: PsScope): Promise<PsScopeReport> {
	const persisted = await readPersistedDaemons(scope.runtimeDir);
	if (scope.brokerPid !== undefined) {
		try {
			const client = await scopeClient(scope);
			if (client) {
				try {
					if (scope.projectDir === undefined) {
						const ping = await client.request({ op: "ping" });
						if (ping.op === "ping") scope.projectDir = ping.projectDir;
					}
					const result = await client.request({ op: "list" });
					if (result.op !== "list") throw new Error(`Unexpected broker response ${result.op}`);
					return {
						scope,
						daemons: result.daemons.map(snapshot => ({
							snapshot,
							command: formatCommand(persisted.get(snapshot.name)?.spec),
							cwd: persisted.get(snapshot.name)?.spec.cwd,
							supervised: true,
						})),
					};
				} finally {
					client.close();
				}
			}
		} catch {}
	}
	const daemons: PsDaemonRow[] = [];
	for (const { snapshot, spec } of persisted.values()) {
		const row: PsDaemonRow = { snapshot, command: formatCommand(spec), cwd: spec.cwd, supervised: false };
		if (!TERMINAL_STATES[snapshot.state]) {
			const survivor = spec.detached && snapshot.state !== "stopping" && processAlive(snapshot.pid);
			if (!survivor) {
				row.snapshot = { ...snapshot, state: "exited", exitReason: snapshot.exitReason ?? "broker exited" };
			}
		}
		daemons.push(row);
	}
	daemons.sort(compareRows);
	return { scope, daemons };
}

function compareRows(a: PsDaemonRow, b: PsDaemonRow): number {
	const aTerminal = TERMINAL_STATES[a.snapshot.state] === true;
	const bTerminal = TERMINAL_STATES[b.snapshot.state] === true;
	if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
	return a.snapshot.name.localeCompare(b.snapshot.name);
}

export async function collectReports(all: boolean, target: PsTarget): Promise<PsScopeReport[]> {
	const scopes = all ? await discoverScopes() : [await targetScope(target)];
	const reports = await Promise.all(scopes.map(collectScope));
	return reports.filter(report => !all || report.daemons.length > 0 || report.scope.brokerPid !== undefined);
}

export function formatCommand(spec: DaemonSpec | undefined): string | undefined {
	return spec ? [spec.application, ...spec.args].join(" ") : undefined;
}

export function collapseCommand(command: string | undefined): string {
	return command ? command.replaceAll(/\s+/gu, " ").trim() : "";
}

export function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit}`;
}

function stateCell(row: PsDaemonRow): string {
	const { snapshot } = row;
	let text: string = snapshot.state;
	if (TERMINAL_STATES[snapshot.state] && snapshot.exitCode !== undefined) text += `(${snapshot.exitCode})`;
	const paint =
		snapshot.state === "ready" || snapshot.state === "running"
			? chalk.green
			: snapshot.state === "failed"
				? chalk.red
				: TERMINAL_STATES[snapshot.state]
					? chalk.dim
					: chalk.yellow;
	return paint(text);
}

function flagsCell(row: PsDaemonRow): string {
	const parts: string[] = [];
	if (row.snapshot.detached) parts.push("detached");
	else if (row.snapshot.persist) parts.push("persist");
	if (!row.supervised && !TERMINAL_STATES[row.snapshot.state]) parts.push("unsupervised");
	return parts.join(",");
}

function uptimeCell(snapshot: DaemonSnapshot): string {
	if (TERMINAL_STATES[snapshot.state]) return "-";
	return formatDuration(Date.now() - snapshot.startedAt);
}

export const TABLE_HEADER = ["NAME", "STATE", "PID", "UPTIME", "RESTARTS", "FLAGS", "COMMAND"];

export function tableCells(row: PsDaemonRow): string[] {
	return [
		row.snapshot.name,
		stateCell(row),
		row.snapshot.pid !== undefined && !TERMINAL_STATES[row.snapshot.state] ? String(row.snapshot.pid) : "-",
		uptimeCell(row.snapshot),
		String(row.snapshot.restartCount),
		flagsCell(row),
		collapseCommand(row.command),
	];
}

export function scopeHeader(scope: PsScope): string {
	const label =
		scope.kind === "global"
			? `global ${chalk.bold(scope.service ?? path.basename(scope.runtimeDir))}`
			: `project ${chalk.bold(scope.projectDir ?? path.basename(scope.runtimeDir))}`;
	const broker =
		scope.brokerPid !== undefined ? chalk.green(`broker pid ${scope.brokerPid}`) : chalk.dim("broker not running");
	return `${label} ${chalk.dim("—")} ${broker}`;
}
