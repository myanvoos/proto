import { afterEach, describe, expect, it } from "bun:test";
import {
	createConfigHeaderResolver,
	invalidateAllCommandConfigs,
	invalidateCommandConfig,
} from "./resolve-config-value";

const TEMP_ENV_KEYS: string[] = [];

function setEnv(key: string, value: string): void {
	TEMP_ENV_KEYS.push(key);
	process.env[key] = value;
}

function delayedValueCommand(value: string): string {
	if (process.platform !== "win32") return `!sleep 0.15; printf %s ${JSON.stringify(value)}`;
	return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
		`setTimeout(() => process.stdout.write(${JSON.stringify(value)}), 150)`,
	)}`;
}

afterEach(() => {
	for (const key of TEMP_ENV_KEYS.splice(0)) delete process.env[key];
	invalidateAllCommandConfigs();
});

describe("request-time config header resolution", () => {
	it("rejects on abort while a header source is still pending instead of returning partial headers", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<Record<string, string>>();
		const resolver = createConfigHeaderResolver([
			async () => {
				started.resolve();
				return release.promise;
			},
		]);
		if (!resolver) throw new Error("Expected a header resolver");
		const controller = new AbortController();
		const pending = resolver(controller.signal);
		try {
			await started.promise;
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			release.resolve({ Authorization: "too late" });
		}
	});

	it("layers nested resolvers with later sources winning and authHeader applied last", async () => {
		setEnv("PROTO_TEST_LIVE_KEY", "sekret");
		const inner = createConfigHeaderResolver([{ "X-Tenant": "old", "X-Keep": "k", Authorization: "wrong" }]);
		const outer = createConfigHeaderResolver([inner, { "X-Tenant": "new" }], {
			authHeader: true,
			apiKeyConfig: "PROTO_TEST_LIVE_KEY",
		});

		expect(await outer?.()).toEqual({ "X-Tenant": "new", "X-Keep": "k", Authorization: "Bearer sekret" });
	});

	it("re-reads environment-backed values on every request", async () => {
		setEnv("PROTO_TEST_LIVE_DYN", "v1");
		const resolver = createConfigHeaderResolver([{ "X-Dyn": "PROTO_TEST_LIVE_DYN" }]);

		expect((await resolver?.())?.["X-Dyn"]).toBe("v1");
		setEnv("PROTO_TEST_LIVE_DYN", "v2");
		expect((await resolver?.())?.["X-Dyn"]).toBe("v2");
	});

	it("runs command-backed headers without blocking the event loop and caches until invalidated", async () => {
		const command = delayedValueCommand("token");
		const resolver = createConfigHeaderResolver([{ Authorization: command }]);
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 20);

		const pending = resolver?.();
		// Real time is intentional: fake timers cannot observe a synchronous child-process API blocking the loop.
		await Bun.sleep(50);
		expect(timerFired).toBe(true);
		expect(await pending).toEqual({ Authorization: "token" });
		clearTimeout(timer);

		// Cached: a second request does not wait on the command again.
		const cachedStart = performance.now();
		expect(await resolver?.()).toEqual({ Authorization: "token" });
		expect(performance.now() - cachedStart).toBeLessThan(100);

		// Invalidated (auth retry): the next request re-runs the command.
		invalidateCommandConfig(command);
		const rerunStart = performance.now();
		expect(await resolver?.()).toEqual({ Authorization: "token" });
		expect(performance.now() - rerunStart).toBeGreaterThanOrEqual(100);
	});

	it("resolves a deeply composed parent-child chain once per layer", async () => {
		const depth = 64;
		let baseReads = 0;
		const base = async (): Promise<Record<string, string>> => {
			baseReads++;
			return { "X-Base": "b" };
		};
		let resolver = createConfigHeaderResolver([base]);
		for (let i = 0; i < depth; i++) {
			resolver = createConfigHeaderResolver([resolver, { [`X-L${i}`]: String(i) }]);
		}

		const headers = await resolver?.();
		expect(Object.keys(headers ?? {})).toHaveLength(depth + 1);
		expect(headers?.["X-Base"]).toBe("b");
		expect(headers?.[`X-L${depth - 1}`]).toBe(String(depth - 1));
		expect(baseReads).toBe(1);
	});
});
