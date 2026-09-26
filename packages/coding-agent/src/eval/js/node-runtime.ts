import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { $which } from "@oh-my-pi/pi-utils";
import { stageRunnerScript } from "../runner-cache";

/** PATH names a `node` cell resolves, in order — the builtin's own name first, then Debian's `nodejs`. */
const NODE_INTERPRETERS = ["node", "nodejs"];

/**
 * The standalone JS kernel bundle (node-entry.ts built for `--target=node`, compatible with Bun too).
 * Build scripts embed it through this define; a source checkout builds it on first use instead.
 */
const EMBEDDED_JS_KERNEL = process.env.PI_JS_KERNEL ?? "";

const NATIVES_STUB_NAMESPACE = "js-kernel-natives-stub";

/**
 * Do not bundle the host's addon loader/archive into the standalone interpreter kernel.
 * Its stdio capture loads the exact validated addon path supplied by the host. Incidental
 * host-only bindings remain unavailable; plain-data enums still work without the addon.
 */
const nativesStubPlugin: Bun.BunPlugin = {
	name: NATIVES_STUB_NAMESPACE,
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives(?:\/loader)?$/ }, args => ({
			path: args.path.endsWith("/loader") ? "loader" : "natives",
			namespace: NATIVES_STUB_NAMESPACE,
		}));
		build.onLoad({ filter: /.*/, namespace: NATIVES_STUB_NAMESPACE }, args => ({
			contents:
				args.path === "loader"
					? 'export function getNativeAddonPath() { const path = process.env.PI_JS_NATIVE_ADDON; if (!path) throw new Error("JS kernel native addon path is missing"); return path; }'
					: [
							'import { createRequire } from "node:module";',
							'const unavailable = name => function () { throw new Error(name + ": native bindings are unavailable in standalone JS kernels"); };',
							'export class KernelStdio { constructor(...args) { const path = process.env.PI_JS_NATIVE_ADDON; if (!path) throw new Error("JS kernel native addon path is missing"); const { KernelStdio: Capture } = createRequire(import.meta.url)(path); return new Capture(...args); } }',
							...Object.entries(natives)
								.filter(([name]) => name !== "KernelStdio")
								.map(([name, value]) =>
									typeof value === "function"
										? `export const ${name} = unavailable(${JSON.stringify(name)});`
										: `export const ${name} = ${JSON.stringify(value)};`,
								),
						].join("\n"),
			loader: "js",
		}));
	},
};

/** Bundles node-entry.ts into one self-contained ES module for the selected Node or Bun executable. */
export async function buildJsKernel(): Promise<string> {
	const output = await Bun.build({
		entrypoints: [path.join(import.meta.dir, "node-entry.ts")],
		target: "node",
		format: "esm",
		// Keep function names readable in cell error stacks.
		minify: { whitespace: true, syntax: true, identifiers: false },
		plugins: [nativesStubPlugin],
		throw: false,
	});
	if (!output.success) throw new Error(`JS kernel bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	if (output.outputs.length !== 1)
		throw new Error(`JS kernel bundle produced ${output.outputs.length} files; expected one`);
	return await output.outputs[0].text();
}

let built: Promise<string> | undefined;

function jsKernelSource(): Promise<string> {
	if (EMBEDDED_JS_KERNEL) return Promise.resolve(EMBEDDED_JS_KERNEL);
	if (!built) {
		const building = buildJsKernel();
		built = building;
		building.catch(() => {
			if (built === building) built = undefined;
		});
	}
	return built;
}

/** Path of the staged standalone JS kernel entry module. */
export async function stageJsKernel(): Promise<string> {
	return await stageRunnerScript("proto-js-kernel", "mjs", await jsKernelSource());
}

/** The Node a `node` command resolves to on the cell's PATH, as the shell would run it. */
export function resolveNodeInterpreter(
	env: Record<string, string | undefined> | undefined,
	cwd: string,
): string | undefined {
	const PATH = env?.PATH ?? process.env.PATH;
	for (const name of NODE_INTERPRETERS) {
		const found = $which(name, { PATH, cwd });
		if (found) return found;
	}
	return undefined;
}

export const NODE_REMOTE_TARGET_UNSUPPORTED =
	"node kernels run on the local host only; use `bun` cells for a remote or container target, or run node there as an ordinary command";

export const NODE_INTERPRETER_NOT_FOUND = `Node.js not found (no ${NODE_INTERPRETERS.join(" or ")} on PATH); install Node.js >= 22 or start the lane with an explicit interpreter: protolens context --resource kernel --op start --language node --interpreter /path/to/node`;
