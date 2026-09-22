import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Component, type Focusable, Input, Key, matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { bottomBorder, getDialogViewport, row, topBorder } from "./overlay-box";

export interface MoveOverlayResult {
	directory: string;
}

interface DirEntry {
	value: string;

	label: string;
}

const MAX_RESULTS = 15;

const DIR_CACHE_TTL = 500;
const dirCache = new Map<string, { time: number; entries: fs.Dirent[] }>();

function readDirCached(dir: string): fs.Dirent[] {
	const now = Date.now();
	const cached = dirCache.get(dir);
	if (cached && now - cached.time < DIR_CACHE_TTL) return cached.entries;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		dirCache.set(dir, { time: now, entries });
		return entries;
	} catch {
		return [];
	}
}

function entryIsDirectory(dir: string, entry: fs.Dirent): boolean {
	if (entry.isDirectory()) return true;

	if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
		return false;
	}

	try {
		return fs.statSync(path.join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

function printableInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	return Array.from(withoutPasteEnvelope)
		.filter(ch => {
			const code = ch.codePointAt(0);
			// Reject C1 (0x80-0x9f) alongside C0/DEL: raw C1 bytes would be
			// interpreted as terminal control introducers.
			return code !== undefined && code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
		})
		.join("");
}

export function resolveMovePath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

export function resolveExistingDirectory(input: string, cwd: string): string | null {
	const resolved = resolveMovePath(input, cwd);
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

function listChildDirectories(dirPath: string, max: number, includeHidden = false): DirEntry[] {
	const results: DirEntry[] = [];
	const entries = readDirCached(dirPath);
	for (const entry of entries) {
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (!entryIsDirectory(dirPath, entry)) continue;
		results.push({ value: path.join(dirPath, name), label: `${name}/` });
	}
	results.sort((a, b) => a.label.localeCompare(b.label));
	return results.slice(0, max);
}

function searchDirectories(prefix: string, cwd: string, max: number): DirEntry[] {
	if (!prefix) return listChildDirectories(cwd, max);

	const norm = prefix.replace(/\\/g, "/");
	const slashIdx = norm.lastIndexOf("/");
	let baseDir: string;
	let query: string;
	if (slashIdx === -1) {
		baseDir = cwd;
		query = prefix;
	} else {
		const base = norm.slice(0, slashIdx + 1);
		query = norm.slice(slashIdx + 1);
		baseDir = resolveMovePath(base, cwd);
	}

	const includeHidden = query.startsWith(".");

	const resolved = includeHidden ? null : resolveExistingDirectory(prefix, cwd);
	if (resolved) return listChildDirectories(resolved, max);

	const lower = query.toLowerCase();
	const results: DirEntry[] = [];
	const entries = readDirCached(baseDir);
	for (const entry of entries) {
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (query && !name.toLowerCase().includes(lower)) continue;
		if (!entryIsDirectory(baseDir, entry)) continue;
		results.push({ value: path.join(baseDir, name), label: `${name}/` });
	}
	results.sort((a, b) => a.label.localeCompare(b.label));
	return results.slice(0, max);
}

export class MoveOverlay implements Component, Focusable {
	#focused = false;
	#input = new Input();
	#maxHeight: number | undefined;
	#selectedIndex = 0;
	#results: DirEntry[] = [];
	#cwd: string;
	#done: (result: MoveOverlayResult | undefined) => void;

	constructor(cwd: string, done: (result: MoveOverlayResult | undefined) => void) {
		this.#cwd = cwd;
		this.#done = done;

		readDirCached(cwd);
		this.#updateResults();
	}

	setMaxHeight(rows: number): void {
		this.#maxHeight = Math.max(1, Math.trunc(rows));
	}

	setUseTerminalCursor(value: boolean): void {
		this.#input.setUseTerminalCursor(value);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.#confirm();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, Key.up)) {
			if (this.#results.length > 0) this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, Key.down)) {
			if (this.#results.length > 0)
				this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#input.setValue(selected.value);
				this.#selectedIndex = 0;
				this.#updateResults();
			}
			return;
		}
		const before = this.#input.getValue();
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.backspace)) {
			this.#input.handleInput(data);
		} else {
			const text = printableInput(data);
			if (text) this.#input.pasteText(text);
		}
		if (this.#input.getValue() !== before) {
			this.#selectedIndex = 0;
			this.#updateResults();
		}
	}

	pasteText(text: string): void {
		this.handleInput(`\x1b[200~${text}\x1b[201~`);
	}

	render(width: number): readonly string[] {
		const viewport = getDialogViewport(this.#maxHeight ?? (process.stdout.rows || 40));
		// The path and selected result are both active controls. Reclaim
		// optional chrome before allowing either to fall outside the viewport.
		viewport.bodyRows += viewport.dividerRows;
		viewport.dividerRows = 0;
		const minimumBody = this.#results.length > 0 ? 2 : 1;
		if (viewport.bodyRows < minimumBody) {
			viewport.bodyRows += viewport.footerRows;
			viewport.footerRows = 0;
		}
		if (viewport.bodyRows < minimumBody) {
			viewport.bodyRows += viewport.titleRows + viewport.bottomRows;
			viewport.titleRows = 0;
			viewport.bottomRows = 0;
		}
		const innerWidth = Math.max(1, viewport.titleRows ? width - 4 : width);
		this.#input.prompt = theme.fg("dim", innerWidth > 6 ? "Path: " : innerWidth > 2 ? "> " : "");
		this.#input.focused = this.#focused;
		const lines = viewport.titleRows ? [topBorder(width, "Move to directory")] : [];
		lines.push(row(this.#input.render(innerWidth)[0] ?? "", width, viewport.titleRows > 0));

		const resultRows = Math.max(0, viewport.bodyRows - 1);
		if (this.#results.length === 0 && this.#input.getValue().length > 0 && resultRows > 0) {
			const message = resolveExistingDirectory(this.#input.getValue(), this.#cwd)
				? "No subdirectories"
				: "No matching directories";
			lines.push(row(theme.fg("dim", message), width, viewport.titleRows > 0));
		} else {
			const start = Math.max(
				0,
				Math.min(this.#selectedIndex - Math.floor(resultRows / 2), this.#results.length - resultRows),
			);
			for (let i = start; i < Math.min(this.#results.length, start + resultRows); i++) {
				const item = this.#results[i]!;
				const selected = i === this.#selectedIndex;
				const marker = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				lines.push(row(`${marker}${label}`, width, viewport.titleRows > 0));
			}
		}
		if (viewport.footerRows) {
			const hints = [
				"Enter confirm · Esc cancel · ↑↓ navigate · Tab accept · Type to filter",
				"Enter confirm · Esc cancel",
				"Enter · Esc",
			];
			const hint = hints.find(text => visibleWidth(text) <= innerWidth) ?? hints[hints.length - 1]!;
			lines.push(row(theme.fg("dim", hint), width, viewport.titleRows > 0));
		}
		if (viewport.bottomRows) lines.push(bottomBorder(width));
		return lines;
	}

	invalidate(): void {}

	#updateResults(): void {
		// Keep the search cap independent of terminal height; rendering scrolls
		// this result set to keep the selected entry visible.
		this.#results = searchDirectories(this.#input.getValue(), this.#cwd, MAX_RESULTS);
		if (this.#selectedIndex >= this.#results.length) {
			this.#selectedIndex = Math.max(0, this.#results.length - 1);
		}
	}

	#confirm(): void {
		const selected = this.#results[this.#selectedIndex];
		if (selected) {
			this.#done({ directory: selected.value });
			return;
		}
		if (this.#input.getValue().trim().length > 0) {
			this.#done({ directory: this.#input.getValue().trim() });
			return;
		}
		this.#done(undefined);
	}
}
