import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventBus } from "../../utils/event-bus";
import {
	bindPreparedExtensions,
	discoverExtensionPaths,
	ExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("extension package manifest entries cannot escape the package root", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-extension-manifest-"));
	tempDirs.push(tempDir);
	const packageRoot = path.join(tempDir, "nested", "extension");
	const outsidePath = path.join(tempDir, "outside.ts");
	await fs.mkdir(packageRoot, { recursive: true });
	await Bun.write(outsidePath, "export default () => {};\n");
	await Bun.write(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: "unsafe-extension", proto: { extensions: ["../../outside.ts"] } }),
	);

	const discovered = await discoverExtensionPaths([packageRoot], tempDir, [], {
		ambient: false,
		includeAmbientHooks: false,
	});

	expect(discovered).toEqual([]);
});

test("a declared extension manifest stays authoritative when its entries are missing", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-extension-manifest-missing-"));
	tempDirs.push(tempDir);
	const packageRoot = path.join(tempDir, "configured-package");
	await fs.mkdir(packageRoot, { recursive: true });
	await Bun.write(path.join(packageRoot, "index.ts"), "export default () => {};\n");
	await Bun.write(path.join(packageRoot, "package.json"), JSON.stringify({ proto: { extensions: ["./missing.ts"] } }));

	const discovered = await discoverExtensionPaths([packageRoot], tempDir, [], {
		ambient: false,
		includeAmbientHooks: false,
	});

	expect(discovered).toEqual([]);
});

test("extension API methods keep their binding when destructured", async () => {
	const extension = await loadExtensionFromFactory(
		pi => {
			const { on, registerCommand } = pi;
			on("session_start", () => {});
			registerCommand("detached", { handler: async () => {} });
		},
		process.cwd(),
		new EventBus(),
		new ExtensionRuntime(),
	);

	expect(extension.handlers.get("session_start")).toHaveLength(1);
	expect(extension.commands.has("detached")).toBe(true);
});

// Regression: every subagent re-imported its parent's extensions under a fresh module tag, re-running their top-level
// code and growing the process module registry with each spawn.
test("a child session rebinds its parent's extensions without evaluating them again", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-prepared-extension-"));
	tempDirs.push(tempDir);
	const extensionPath = path.join(tempDir, "counter.ts");
	const counterKey = `__proto_prepared_extension_${crypto.randomUUID().replaceAll("-", "")}`;
	await Bun.write(
		extensionPath,
		`Reflect.set(globalThis, ${JSON.stringify(counterKey)}, Number(Reflect.get(globalThis, ${JSON.stringify(counterKey)}) ?? 0) + 1);\nexport default function counterExtension() {}\n`,
	);

	const parent = await loadExtensions([extensionPath], tempDir);
	expect(parent.preparedExtensions).toHaveLength(1);
	expect(Reflect.get(globalThis, counterKey)).toBe(1);

	const child = await bindPreparedExtensions(parent.preparedExtensions ?? [], tempDir);
	expect(Reflect.get(globalThis, counterKey)).toBe(1);
	expect(child.extensions).toHaveLength(1);
	expect(child.extensions[0]).not.toBe(parent.extensions[0]);
	expect(child.runtime).not.toBe(parent.runtime);
});
