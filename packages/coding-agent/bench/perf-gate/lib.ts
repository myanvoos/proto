import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

export const PKG_ROOT = path.resolve(import.meta.dir, "../..");
export const RESULTS_DIR = path.join(PKG_ROOT, "bench", "perf-gate", "results");

export function median(xs: number[]): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function pct(xs: number[], p: number): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[idx]!;
}

export function mean(xs: number[]): number {
	return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export function writeResults(name: string, data: unknown): string {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const file = path.join(RESULTS_DIR, name);
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
	return file;
}

export function envInt(name: string, dflt: number): number {
	const v = process.env[name];
	if (!v) return dflt;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function fmtMs(ms: number): string {
	return `${ms.toFixed(2)}ms`;
}
