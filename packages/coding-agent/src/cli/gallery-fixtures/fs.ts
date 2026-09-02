import type { Usage } from "@oh-my-pi/pi-ai";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import type { GalleryFixture, GalleryFixtureState, GalleryResult } from "./types";

const readSnippet = [
	"export function tokenizeShellSegments(command: string): string[][] {",
	"\tconst segments: string[][] = [];",
	"\tlet current: string[] = [];",
	'\tlet buffer = "";',
	"\tlet inSingle = false;",
	"\tlet inDouble = false;",
	"\tconst pushBuffer = () => {",
	"\t\tif (buffer.length > 0) {",
	"\t\t\tcurrent.push(buffer);",
	'\t\t\tbuffer = "";',
	"\t\t}",
	"\t},",
].join("\n");

const groupedReadTargets = [
	"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
	"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-310",
	"packages/tui/test/streaming-scrollback-defer.test.ts:89-464",
];

const groupedReadDelimitedPath = groupedReadTargets.join(",");
const groupedReadRepeatedFile = "packages/coding-agent/src/task/executor.ts";
const groupedReadRepeatedRanges = `${groupedReadRepeatedFile}:507-605,1070-1194,1210-1240,1270-1274`;

const GROUPED_READ_USAGE: Usage = {
	input: 2400,
	output: 113,
	cacheRead: 103_000,
	cacheWrite: 0,
	totalTokens: 105_513,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textResult(text: string, details?: unknown, isError?: boolean): GalleryResult {
	return { content: [{ type: "text", text }], details, isError };
}

function addGroupedReadArgs(component: ReadToolGroupComponent): void {
	component.updateArgs({ path: groupedReadDelimitedPath }, "read-delimited");
	component.updateArgs({ path: groupedReadRepeatedRanges }, "read-ranges");
}

function renderReadGroupFixtureState(state: GalleryFixtureState, width: number, expanded: boolean): readonly string[] {
	const component = new ReadToolGroupComponent();
	component.setExpanded(expanded);

	if (state === "streaming") {
		component.updateArgs(
			{
				path: [
					"packages/coding-agent/test/streaming-preview-height.test.ts:301-409",
					"packages/coding-agent/test/tool-live-region-scrollback.test.ts:143-",
				].join(","),
			},
			"read-delimited",
		);
		return component.render(width);
	}

	addGroupedReadArgs(component);
	if (state === "progress") return component.render(width);

	component.updateResult(
		textResult("Read three focused test ranges.", { displayReadTargets: groupedReadTargets }),
		false,
		"read-delimited",
	);
	component.attachUsage(
		["read-delimited"],
		GROUPED_READ_USAGE,
		5300,
		2200,
		new Date(2026, 6, 28, 21, 5, 47).getTime(),
	);

	if (state === "error") {
		component.updateResult(
			textResult("Error: selector 1270-1274 is outside the file", undefined, true),
			false,
			"read-ranges",
		);
		component.attachUsage(
			["read-ranges"],
			GROUPED_READ_USAGE,
			4700,
			1900,
			new Date(2026, 6, 28, 21, 5, 52).getTime(),
		);
		return component.render(width);
	}

	component.updateResult(textResult("Read four render.ts ranges."), false, "read-ranges");
	component.attachUsage(["read-ranges"], GROUPED_READ_USAGE, 4700, 1900, new Date(2026, 6, 28, 21, 5, 52).getTime());
	return component.render(width);
}

export const fsFixtures: Record<string, GalleryFixture> = {
	read: {
		label: "Read",

		streamingArgs: { path: "packages/coding-agent/src/tools/shell-tokenize" },
		args: { path: "packages/coding-agent/src/tools/shell-tokenize.ts:1-12" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"[packages/coding-agent/src/tools/shell-tokenize.ts#E48E]",
						"1:export function tokenizeShellSegments(command: string): string[][] {",
						"2:\tconst segments: string[][] = [];",
						"3:\tlet current: string[] = [];",
						'4:\tlet buffer = "";',
						"5:\tlet inSingle = false;",
						"6:\tlet inDouble = false;",
						"7:\tconst pushBuffer = () => {",
						"8:\t\tif (buffer.length > 0) {",
						"9:\t\t\tcurrent.push(buffer);",
						'10:\t\t\tbuffer = "";',
						"11:\t\t}",
						"12:\t},",
					].join("\n"),
				},
			],
			details: {
				kind: "file",
				resolvedPath: "/Users/dev/Projects/pi/packages/coding-agent/src/tools/shell-tokenize.ts",
				contentType: "text/typescript",
				displayContent: { text: readSnippet, startLine: 437 },
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Error: ENOENT: no such file or directory, open 'packages/coding-agent/src/tools/shell-tokenize.ts'",
				},
			],
		},
	},

	read_group: {
		label: "Read Groups",
		args: {},
		result: textResult("Rendered grouped read calls."),
		errorResult: textResult("Rendered grouped read errors.", undefined, true),
		renderState: renderReadGroupFixtureState,
	},

	glob: {
		label: "Glob",

		streamingArgs: { path: "packages/coding-agent/src/tools/*-render" },
		args: { path: "packages/coding-agent/src/**/*.test.ts", limit: 50 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"packages/coding-agent/src/tools/read.test.ts",
						"packages/coding-agent/src/tools/write.test.ts",
						"packages/coding-agent/src/tools/glob.test.ts",
						"packages/coding-agent/src/cli/gallery-cli.test.ts",
						"packages/coding-agent/src/edit/edit.test.ts",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/coding-agent/src",
				cwd: "/Users/dev/Projects/pi",
				fileCount: 5,
				truncated: false,
				files: [
					"packages/coding-agent/src/cli/gallery-cli.test.ts",
					"packages/coding-agent/src/edit/edit.test.ts",
					"packages/coding-agent/src/tools/glob.test.ts",
					"packages/coding-agent/src/tools/read.test.ts",
					"packages/coding-agent/src/tools/write.test.ts",
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Glob failed: invalid glob pattern '[unclosed'." }],
			details: { error: "invalid glob pattern '[unclosed'" },
		},
	},
};
