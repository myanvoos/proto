import { buildJsKernel } from "../src/eval/js/node-runtime";
import { createClaudeAgentPlugin } from "./claude-agent-plugin";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createHostVirtualModulePlugin } from "./host-virtual-module";
import { createJsonParsePlugin } from "./json-parse-plugin";

export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

export interface CodingAgentCompileOptions {
	readonly repoRoot: string;

	readonly entrypoint: string;

	readonly outfile: string;

	readonly transformersVersion: string;

	readonly target?: Bun.Build.CompileTarget;

	readonly executablePath?: string;

	readonly minifyIdentifiers?: boolean;

	readonly skipBuiltinCodesign?: boolean;
}

export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const [docsPayload, jsKernel] = await Promise.all([buildDocsIndexPayload(), buildJsKernel()]);
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docsPayload.payload),
				"process.env.PI_JS_KERNEL": JSON.stringify(jsKernel),
			},
			splitting: true,
			// Distinct modules can share both a basename and an emitted-content hash.
			// Keep their source directories so lazy host exports do not collide.
			naming: { chunk: "./chunks/[dir]/[name]-[hash].[ext]" },
			minify: {
				identifiers: options.minifyIdentifiers ?? true,
				whitespace: true,
				syntax: true,
				keepNames: true,
			},
			plugins: [
				await createHostVirtualModulePlugin(),
				createClaudeAgentPlugin(options.target),
				createJsonParsePlugin(),
			],
			compile: {
				...(options.executablePath
					? { executablePath: options.executablePath }
					: options.target
						? { target: options.target }
						: {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
