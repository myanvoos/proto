import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { $which } from "@oh-my-pi/pi-utils";
import { stageRunnerScript } from "../runner-cache";

/** PATH names a `node` cell resolves, in order — the builtin's own name first, then Debian's `nodejs`. */
const NODE_INTERPRETERS = ["node", "nodejs"];

/**
 * The Node kernel runtime bundle (node-entry.ts built for `--target=node`). The build scripts embed it
 * through this define; a source checkout — dev mode and `bun test` — builds it on first use instead.
 */
const EMBEDDED_NODE_KERNEL = process.env.PI_NODE_JS_KERNEL ?? "";

const NATIVES_STUB_NAMESPACE = "node-kernel-natives-stub";

/**
 * Kernel code reaches `@oh-my-pi/pi-natives` only through incidental imports of shared host modules, and Node cannot
 * load it: its loader is Bun-only, and release builds embed the addon archive as a bundle asset. The Node kernel bundle
 * swaps the package for a module that keeps its plain-data enums and makes every binding throw when used.
 */
const nativesStubPlugin: Bun.BunPlugin = {
	name: NATIVES_STUB_NAMESPACE,
	setup(build) {
		build.onResolve({ filter: /^@oh-my-pi\/pi-natives$/ }, () => ({
			path: "natives",
			namespace: NATIVES_STUB_NAMESPACE,
		}));
		build.onLoad({ filter: /.*/, namespace: NATIVES_STUB_NAMESPACE }, () => ({
			contents: [
				'const unavailable = name => function () { throw new Error(name + ": native bindings are unavailable in node kernels"); };',
				...Object.entries(natives).map(([name, value]) =>
					typeof value === "function"
						? `export const ${name} = unavailable(${JSON.stringify(name)});`
						: `export const ${name} = ${JSON.stringify(value)};`,
				),
			].join("\n"),
			loader: "js",
		}));
	},
};

/** Bundles node-entry.ts and its imports into one self-contained ES module for Node. */
export async function buildNodeJsKernel(): Promise<string> {
	const output = await Bun.build({
		entrypoints: [path.join(import.meta.dir, "node-entry.ts")],
		target: "node",
		format: "esm",
		// Identifiers stay readable: kernel frames in cell error stacks must name real functions, as in bun cells.
		minify: { whitespace: true, syntax: true, identifiers: false },
		plugins: [nativesStubPlugin],
		throw: false,
	});
	if (!output.success)
		throw new Error(`Node JS kernel bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
	if (output.outputs.length !== 1)
		throw new Error(`Node JS kernel bundle produced ${output.outputs.length} files; expected one`);
	return await output.outputs[0].text();
}

let built: Promise<string> | undefined;

function nodeJsKernelSource(): Promise<string> {
	if (EMBEDDED_NODE_KERNEL) return Promise.resolve(EMBEDDED_NODE_KERNEL);
	if (!built) {
		const building = buildNodeJsKernel();
		built = building;
		building.catch(() => {
			if (built === building) built = undefined;
		});
	}
	return built;
}

/** Path of the staged Node kernel entry module. */
export async function stageNodeJsKernel(): Promise<string> {
	return await stageRunnerScript("proto-node-kernel", "mjs", await nodeJsKernelSource());
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

export const NODE_INTERPRETER_NOT_FOUND = `Node.js not found (no ${NODE_INTERPRETERS.join(" or ")} on PATH); install Node.js >= 22 or start the lane with an explicit interpreter: xd context --resource kernel --op start --language node --interpreter /path/to/node`;
