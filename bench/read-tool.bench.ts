import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "../packages/coding-agent/src/sdk";
import { ReadTool } from "../packages/coding-agent/src/tools/read";
import { formatArtifact, runSuite } from "./harness";

const settingsValues: Record<string, unknown> = {
	"images.autoResize": false,
	"read.defaultLimit": 200,
	readLineNumbers: false,
	"read.renderMarkdown": false,
	"read.summarize.enabled": false,
	"fetch.enabled": true,
	"bashInterceptor.enabled": false,
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"kernel.speculation.enabled": false,
	"kernel.assertPreflight.enabled": false,
	"bash.direnv": "off",
	"tools.maxTimeout": 300,
	"tools.outputMaxColumns": 0,
};

function benchSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: {
			get: (key: string) => settingsValues[key],
			getShellConfig: () => ({ env: {} }),
			getStorage: () => null,
		},
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "read-tool-bench",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
}

type Fixture = { read: ReadTool; selectorPath: string };

async function setupFixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-bench-"));
	const lines = Array.from(
		{ length: 50_000 },
		(_, index) => `${String(index + 1).padStart(5, "0")}-${"x".repeat(100)}`,
	);
	await Bun.write(path.join(root, "large.txt"), `${lines.join("\n")}\n`);
	return { read: new ReadTool(benchSession(root)), selectorPath: path.join(root, "large.txt") };
}

async function readRanges(fixture: Fixture, rangeCount: number): Promise<void> {
	const start = 50_000 - rangeCount * 2;
	const ranges = Array.from({ length: rangeCount }, (_, index) => {
		const line = start + index * 2;
		return `${line}-${line}`;
	}).join(",");
	await fixture.read.execute(`bench-${rangeCount}`, { path: `${fixture.selectorPath}:${ranges}` });
}

const artifact = await runSuite(
	"read-tool",
	[
		{ name: "ranges-8", setup: setupFixture, run: fixture => readRanges(fixture, 8) },
		{ name: "ranges-32", setup: setupFixture, run: fixture => readRanges(fixture, 32) },
	],
	{ runs: 10, warmup: 2 },
);
console.log(formatArtifact(artifact));
