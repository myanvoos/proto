import { buildDocsIndexPayload } from "./generate-docs-index";
import { createHostVirtualModulePlugin } from "./host-virtual-module";

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
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			splitting: true,
			minify: {
				identifiers: options.minifyIdentifiers ?? true,
				whitespace: true,
				syntax: true,
				keepNames: true,
			},
			plugins: [await createHostVirtualModulePlugin()],
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
