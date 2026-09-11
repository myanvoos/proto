#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { buildDocsIndexPayload } from "./generate-docs-index";

const packageDir = path.join(import.meta.dir, "..");
const outDir = path.join(packageDir, "dist");
const cliPath = path.join(outDir, "cli.js");
const shebang = "#!/usr/bin/env bun\n";
const legacyHtmlExportAssetPattern = /^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js)$/;

const ALWAYS_EXTERNAL = [
	"@oh-my-pi/pi-natives",
	"@huggingface/transformers",
	"fastembed",
	"onnxruntime-node",
	"proto-host-modules",
];

const RUNTIME_EXTERNAL = ["puppeteer-core", "@babel/parser"];

async function ensureShebang(): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(
				entry =>
					entry === "cli.js" ||
					entry === "docs-index.generated.txt" ||
					entry.endsWith(".node") ||
					entry.endsWith(".js.map") ||
					(entry.startsWith("chunk-") && entry.endsWith(".js")) ||
					(entry.startsWith("CHANGELOG-") && entry.endsWith(".md")) ||
					legacyHtmlExportAssetPattern.test(entry),
			)
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

async function main(): Promise<void> {
	const start = Bun.nanoseconds();
	await cleanBundleOutputs();

	const docsPayload = await buildDocsIndexPayload();

	const output = await Bun.build({
		entrypoints: [path.join(packageDir, "src/cli.ts")],
		outdir: outDir,
		target: "bun",
		splitting: true,
		naming: { chunk: "template-split-[hash].[ext]" },
		external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
		define: {
			"process.env.PI_BUNDLED": JSON.stringify("true"),
			"process.env.PI_DOCS_EMBED": JSON.stringify(docsPayload.payload),
		},
		minify: {
			whitespace: true,
			syntax: true,
			identifiers: true,
			keepNames: true,
		},
		throw: false,
	});
	if (!output.success) {
		throw new Error(`CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	await ensureShebang();
	await Bun.write(path.join(outDir, "docs-index.generated.txt"), docsPayload.payload);

	const stat = await fs.stat(cliPath);
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to dist/cli.js (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

await main();
