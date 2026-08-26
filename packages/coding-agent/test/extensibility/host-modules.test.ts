import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import {
	__getHostBundledModulesGlobal,
	__rewriteHostExtensionSourceForTests,
	__synthesizeHostBundledSourceWithModules,
	resolveBundledVirtualSpecifier,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/host-module-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunPlugin } from "bun";

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API. Host-module resolution routes current
// `@oh-my-pi/*` imports through virtual modules backed by live host module
// references. The synthesizer must preserve every named/default export.
describe("host bundled virtual module synthesizer (issue #3423)", () => {
	const modules = {
		"@oh-my-pi/pi-coding-agent": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@oh-my-pi/pi-utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		"@oh-my-pi/omptype": {
			type: () => undefined,
		},
	};
	const globalKey = __getHostBundledModulesGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeHostBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
		expect(src).toContain(
			`const __proto_bundled = globalThis[${JSON.stringify(globalKey)}]["@oh-my-pi/pi-coding-agent"];`,
		);
		expect(src).toContain('export const VERSION = __proto_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __proto_bundled["defineTool"];');
		expect(src).toContain('export const Type = __proto_bundled["Type"];');
		// Every named export emerges from a live module lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeHostBundledSourceWithModules("@oh-my-pi/pi-utils", modules);
		expect(src).toContain("export default __proto_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __proto_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __proto_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeHostBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the bundled modules do not cover", () => {
		expect(() => __synthesizeHostBundledSourceWithModules("@oh-my-pi/pi-not-bundled", modules)).toThrow(
			/no bundled module registered for @oh-my-pi\/pi-not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every extension load with a
		// `Cannot read properties of undefined` at first import.
		const src = __synthesizeHostBundledSourceWithModules("@oh-my-pi/omptype", modules);
		expect(
			src.startsWith(`const __proto_bundled = globalThis[${JSON.stringify(globalKey)}]["@oh-my-pi/omptype"];`),
		).toBe(true);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		Reflect.set(globalThis, globalKey, modules);
		try {
			const src = __synthesizeHostBundledSourceWithModules("@oh-my-pi/pi-coding-agent", modules);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__proto_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __proto_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __proto_bundled;`);
			const live: unknown = fn();
			if (typeof live !== "object" || live === null) {
				throw new Error("synthetic module did not resolve an object namespace");
			}
			expect("VERSION" in live ? live.VERSION : undefined).toBe("16.1.17");
			expect(typeof ("defineTool" in live ? live.defineTool : undefined)).toBe("function");
			expect(typeof ("Type" in live ? live.Type : undefined)).toBe("object");
		} finally {
			Reflect.deleteProperty(globalThis, globalKey);
		}
	});

	it("routes Bun plugin resolution through the bundled namespace so onLoad can serve extension imports", async () => {
		using tempDir = TempDir.createSync("@proto-host-bundled-virtual-");
		const entryPath = tempDir.join("extension-entry.ts");
		const bundlePath = tempDir.join("extension-entry.bundle.mjs");

		await Bun.write(
			entryPath,
			['export { hostAnswer } from "proto-host-bundled:@oh-my-pi/pi-utils";', ""].join("\n"),
		);

		expect(resolveBundledVirtualSpecifier("@oh-my-pi/pi-utils")).toEqual({
			namespace: "proto-host-bundled",
			path: "@oh-my-pi/pi-utils",
		});
		expect(resolveBundledVirtualSpecifier("proto-host-bundled:@oh-my-pi/pi-utils")).toEqual({
			namespace: "proto-host-bundled",
			path: "@oh-my-pi/pi-utils",
		});

		const onLoadPaths: string[] = [];
		const plugin: BunPlugin = {
			name: "proto-host-bundled-virtual-regression",
			setup(build) {
				build.onResolve({ filter: /^proto-host-bundled:.+$/, namespace: "file" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onResolve({ filter: /.*/, namespace: "proto-host-bundled" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onLoad({ filter: /.*/, namespace: "proto-host-bundled" }, args => {
					onLoadPaths.push(args.path);
					return {
						contents: `export const hostAnswer = ${JSON.stringify(`served:${args.path}`)};`,
						loader: "js",
					};
				});
			},
		};

		const buildResult = await Bun.build({
			entrypoints: [entryPath],
			external: ["bun"],
			format: "esm",
			plugins: [plugin],
			target: "bun",
		});
		const buildLogs = buildResult.logs.map(log => log.message).join("\n");
		expect(buildResult.success, buildLogs).toBe(true);
		await Bun.write(bundlePath, await buildResult.outputs[0]!.text());
		expect(onLoadPaths).toEqual(["@oh-my-pi/pi-utils"]);

		// Loading boundary under test: the bundle path is runtime-generated, so
		// a static import cannot express it.
		const bundledModule = (await import(url.pathToFileURL(bundlePath).href)) as { hostAnswer: string };
		expect(bundledModule.hostAnswer).toBe("served:@oh-my-pi/pi-utils");
	});

	it("rewrites current-specifier imports in extension source to host package entries", async () => {
		using tempDir = TempDir.createSync("@proto-host-rewrite-");
		const importerPath = path.join(tempDir.path(), "extension.ts");
		await Bun.write(importerPath, 'import { VERSION } from "@oh-my-pi/pi-utils";\nexport { VERSION };\n');

		const rewritten = await __rewriteHostExtensionSourceForTests(
			'import { VERSION } from "@oh-my-pi/pi-utils";\nexport { VERSION };\n',
			importerPath,
		);

		// Source mode maps the specifier onto the real host package entry,
		// spliced in as a JSON-quoted string at the reference position.
		const resolvedEntry = Bun.resolveSync("@oh-my-pi/pi-utils", path.dirname(new URL(import.meta.url).pathname));
		expect(rewritten).toBe(
			`import { VERSION } from ${JSON.stringify(url.pathToFileURL(resolvedEntry).href)};\nexport { VERSION };\n`,
		);

		// Relative siblings stay untouched so Bun resolves them natively.
		const untouched = await __rewriteHostExtensionSourceForTests(
			'export { local } from "./sibling.ts";\n',
			path.join(tempDir.path(), "entry.ts"),
		);
		expect(untouched).toContain('from "./sibling.ts"');
	});
});
