import * as path from "node:path";
import { getLastChangelogVersionPath, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import bundledChangelogPath from "../../CHANGELOG.md" with { type: "file" };
import type { SettingValue } from "../config/settings";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

export const RECENT_CHANGELOG_ENTRY_LIMIT = 3;

export const STARTUP_CHANGELOG_MAX_BYTES = 64 * 1024;

export const STARTUP_CHANGELOG_FULL_HINT = "Truncated — see CHANGELOG.md in the install for full notes.";

interface RenderedChangelog {
	markdown: string;
	truncated: boolean;
}

export interface StartupChangelogSelection {
	markdown: string | undefined;
	persistCurrentVersion: boolean;
	truncated: boolean;
	selectedEntries: number;
	totalUnseenEntries: number;
	latestVersion: string | undefined;
	changeCount: number;
	categoryCounts: Record<string, number>;
}

const CHANGELOG_CATEGORY_ORDER = [
	"Breaking Changes",
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
] as const;

function emptyStartupSelection(persistCurrentVersion: boolean): StartupChangelogSelection {
	return {
		markdown: undefined,
		persistCurrentVersion,
		truncated: false,
		selectedEntries: 0,
		totalUnseenEntries: 0,
		latestVersion: undefined,
		changeCount: 0,
		categoryCounts: {},
	};
}

function summarizeChangelogEntries(entries: readonly ChangelogEntry[]): {
	changeCount: number;
	categoryCounts: Record<string, number>;
} {
	const categoryCounts: Record<string, number> = {};
	let changeCount = 0;

	for (const entry of entries) {
		let category: string | undefined;
		for (const line of entry.content.split("\n")) {
			const heading = line.match(/^###\s+(.+?)\s*$/);
			if (heading) {
				category = heading[1];
				continue;
			}
			if (!category || !/^-\s+\S/.test(line)) continue;
			categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
			changeCount++;
		}
	}

	return { changeCount, categoryCounts };
}

function categoryLabel(category: string, count: number): string {
	if (category === "Breaking Changes") {
		return count === 1 ? "breaking change" : "breaking changes";
	}
	return category.toLowerCase();
}

export function formatStartupChangelogSummary(selection: StartupChangelogSelection): string {
	const latestVersion = selection.latestVersion;
	if (!latestVersion || selection.selectedEntries === 0) {
		return "Updated proto. See CHANGELOG.md in the install for recent changes.";
	}

	const releaseCount = selection.selectedEntries;
	const changeCount = selection.changeCount;
	const releaseWord = releaseCount === 1 ? "release" : "releases";
	const changeWord = changeCount === 1 ? "change" : "changes";
	const firstLine =
		releaseCount === 1
			? `Updated to v${latestVersion} · ${changeCount} ${changeWord} in 1 release`
			: `Updated to v${latestVersion} · ${changeCount} ${changeWord} across ${releaseCount} ${releaseWord}`;

	const orderedCategories = [
		...CHANGELOG_CATEGORY_ORDER.filter(category => selection.categoryCounts[category]),
		...Object.keys(selection.categoryCounts)
			.filter(category => !(CHANGELOG_CATEGORY_ORDER as readonly string[]).includes(category))
			.sort(),
	];
	const breakdown = orderedCategories
		.map(
			category =>
				`${selection.categoryCounts[category]} ${categoryLabel(category, selection.categoryCounts[category])}`,
		)
		.join(" · ");
	const omittedReleases = selection.totalUnseenEntries - selection.selectedEntries;
	const detailHint =
		omittedReleases > 0
			? `+${omittedReleases} earlier ${omittedReleases === 1 ? "release" : "releases"} · See CHANGELOG.md in the install for full history.`
			: "See CHANGELOG.md in the install for details.";

	return breakdown ? `${firstLine}\n${breakdown} · ${detailHint}` : `${firstLine}\n${detailHint}`;
}

export function resolveBundledChangelogPath(assetPath: string, moduleUrl: string | URL): string | URL {
	if (path.isAbsolute(assetPath)) return assetPath;
	return new URL(assetPath, moduleUrl);
}

export async function parseChangelog(changelogPath: string | undefined): Promise<ChangelogEntry[]> {
	let content: string | undefined;
	if (changelogPath) {
		try {
			content = await Bun.file(changelogPath).text();
		} catch (error) {
			if (!isEnoent(error)) {
				logger.error(`Warning: Could not parse changelog: ${error}`);
			}
		}
	}
	content ??= await Bun.file(resolveBundledChangelogPath(bundledChangelogPath, import.meta.url)).text();

	return parseChangelogContent(content);
}

function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: { major: number; minor: number; patch: number } | null = null;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}

			const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (versionMatch) {
				currentVersion = {
					major: Number.parseInt(versionMatch[1], 10),
					minor: Number.parseInt(versionMatch[2], 10),
					patch: Number.parseInt(versionMatch[3], 10),
				};
				currentLines = [line];
			} else {
				currentVersion = null;
				currentLines = [];
			}
		} else if (currentVersion) {
			currentLines.push(line);
		}
	}

	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}

	return entries;
}

async function parseStartupChangelog(
	changelogPath: string | undefined,
	lastVersion: ChangelogEntry,
): Promise<{ entries: ChangelogEntry[]; totalUnseenEntries: number }> {
	if (changelogPath) {
		try {
			return await parseStartupChangelogFile(Bun.file(changelogPath), lastVersion);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.error(`Warning: Could not parse changelog: ${error}`);
			}
		}
	}
	return parseStartupChangelogFile(
		Bun.file(resolveBundledChangelogPath(bundledChangelogPath, import.meta.url)),
		lastVersion,
	);
}

async function parseStartupChangelogFile(
	file: BunFile,
	lastVersion: ChangelogEntry,
): Promise<{ entries: ChangelogEntry[]; totalUnseenEntries: number }> {
	const entries: ChangelogEntry[] = [];
	let currentVersion: ChangelogEntry | undefined;
	let currentLines: string[] | undefined;
	let totalUnseenEntries = 0;

	const finishCurrentEntry = () => {
		if (currentVersion && currentLines) {
			entries.push({ ...currentVersion, content: currentLines.join("\n").trim() });
		}
		currentVersion = undefined;
		currentLines = undefined;
	};
	const processLine = (line: string): boolean => {
		if (!line.startsWith("## ")) {
			currentLines?.push(line);
			return false;
		}

		finishCurrentEntry();
		const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
		if (!versionMatch) return false;

		const version = {
			major: Number.parseInt(versionMatch[1], 10),
			minor: Number.parseInt(versionMatch[2], 10),
			patch: Number.parseInt(versionMatch[3], 10),
			content: "",
		};
		if (compareChangelogEntries(version, lastVersion) <= 0) return true;

		totalUnseenEntries++;
		if (entries.length < RECENT_CHANGELOG_ENTRY_LIMIT) {
			currentVersion = version;
			currentLines = [line];
		}
		return false;
	};

	const decoder = new TextDecoder();
	let pending = "";
	const chunkSize = 32 * 1024;
	for (let start = 0; start < file.size; start += chunkSize) {
		const end = Math.min(start + chunkSize, file.size);
		pending += decoder.decode(await file.slice(start, end).arrayBuffer(), { stream: end < file.size });
		let newlineIndex = pending.indexOf("\n");
		while (newlineIndex !== -1) {
			if (processLine(pending.slice(0, newlineIndex))) {
				return { entries, totalUnseenEntries };
			}
			pending = pending.slice(newlineIndex + 1);
			newlineIndex = pending.indexOf("\n");
		}
	}
	if (pending && !processLine(pending + decoder.decode())) {
		finishCurrentEntry();
	}
	return { entries, totalUnseenEntries };
}

function compareChangelogEntries(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

function parseChangelogVersion(version: string | undefined): ChangelogEntry | undefined {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) {
		return undefined;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		content: "",
	};
}

export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		return [];
	}

	return entries.filter(entry => compareChangelogEntries(entry, parsedLastVersion) > 0);
}

export function renderChangelogEntries(
	entries: ChangelogEntry[],
	options: { maxBytes?: number; truncationHint?: string; oldestFirst?: boolean } = {},
): RenderedChangelog {
	const orderedEntries = options.oldestFirst === false ? entries : [...entries].reverse();
	const markdown = orderedEntries.map(entry => entry.content).join("\n\n");
	if (options.maxBytes === undefined || Buffer.byteLength(markdown) <= options.maxBytes) {
		return { markdown, truncated: false };
	}

	const suffix = `\n\n…\n\n${options.truncationHint ?? STARTUP_CHANGELOG_FULL_HINT}`;
	let low = 0;
	let high = markdown.length;
	while (low < high) {
		const middle = Math.floor((low + high + 1) / 2);
		if (Buffer.byteLength(markdown.slice(0, middle) + suffix) <= options.maxBytes) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	return { markdown: markdown.slice(0, low) + suffix, truncated: true };
}

function selectStartupChangelogEntries(
	newEntries: ChangelogEntry[],
	totalUnseenEntries: number,
): StartupChangelogSelection {
	if (newEntries.length === 0) {
		return emptyStartupSelection(false);
	}

	const rendered = renderChangelogEntries(newEntries, {
		maxBytes: STARTUP_CHANGELOG_MAX_BYTES,
		truncationHint: STARTUP_CHANGELOG_FULL_HINT,
		oldestFirst: false,
	});
	const summary = summarizeChangelogEntries(newEntries);
	const latestEntry = newEntries[0];
	return {
		markdown: rendered.markdown,
		persistCurrentVersion: true,
		truncated: rendered.truncated,
		selectedEntries: newEntries.length,
		totalUnseenEntries,
		latestVersion: latestEntry ? `${latestEntry.major}.${latestEntry.minor}.${latestEntry.patch}` : undefined,
		...summary,
	};
}

export function selectStartupChangelog(
	entries: ChangelogEntry[],
	lastVersion: string | undefined,
	currentVersion: string,
): StartupChangelogSelection {
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		return emptyStartupSelection(true);
	}
	const markerVersion = lastVersion ?? "";
	if (markerVersion === currentVersion) {
		return emptyStartupSelection(false);
	}

	const allNewEntries = getNewEntries(entries, markerVersion);
	return selectStartupChangelogEntries(allNewEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT), allNewEntries.length);
}

export async function resolveStartupChangelogForDisplay(options: {
	mode: SettingValue<"startup.changelogMode">;
	currentVersion: string;
	changelogPath?: string;
	agentDir?: string;
}): Promise<StartupChangelogSelection | undefined> {
	const lastVersion = await readLastChangelogVersion(options.agentDir);
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		return undefined;
	}
	if (lastVersion === options.currentVersion) {
		return undefined;
	}
	if (options.mode === "hidden") {
		const currentVersion = parseChangelogVersion(options.currentVersion);
		if (currentVersion && compareChangelogEntries(currentVersion, parsedLastVersion) > 0) {
			await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		}
		return undefined;
	}
	const { entries, totalUnseenEntries } = await parseStartupChangelog(options.changelogPath, parsedLastVersion);
	const startupChangelog = selectStartupChangelogEntries(entries, totalUnseenEntries);
	if (startupChangelog.persistCurrentVersion) {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
	}
	return startupChangelog.markdown ? startupChangelog : undefined;
}

export { getChangelogPath } from "../config";

export async function readLastChangelogVersion(agentDir?: string): Promise<string | undefined> {
	try {
		const value = (await Bun.file(getLastChangelogVersionPath(agentDir)).text()).trim();
		return value || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read last-changelog-version marker", { error: String(error) });
		}
		return undefined;
	}
}

export async function writeLastChangelogVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastChangelogVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-changelog-version marker", { error: String(error) });
	}
}
