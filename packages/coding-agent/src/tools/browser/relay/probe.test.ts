import { afterEach, expect, test } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { ownedDebuggerTabs } from "../../../../../browser-relay/extension/debugger-ownership";
import { relayExtensionNotice, waitForRelayExtension } from "./probe";
import { isOlderProtoVersion } from "./protocol";

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});
function serve(body: object, status = 200): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}
function ready(extra: object = {}): object {
	return {
		protoRelayVersion: VERSION,
		protoRelayDiscardedTabsProtocol: "1",
		protoExtensionDiscardedTabsProtocol: "1",
		...extra,
	};
}

test("relay probing accepts a compatible other version but identifies an idle older generation for upgrade", async () => {
	expect(await waitForRelayExtension(serve(ready({ protoRelayVersion: "0.1.0", protoRelayCdpClients: 1 })))).toBe(
		"ready",
	);
	expect(await waitForRelayExtension(serve(ready({ protoRelayVersion: "0.1.0", protoRelayCdpClients: 0 })))).toBe(
		"idle-older-relay",
	);
});

test("relay probing distinguishes missing relay capability from missing extension capability", async () => {
	expect(await waitForRelayExtension(serve({ protoRelayVersion: VERSION }))).toBe("outdated-relay");
	expect(
		await waitForRelayExtension(serve({ protoRelayVersion: VERSION, protoRelayDiscardedTabsProtocol: "1" })),
	).toBe("outdated-extension");
});

test("relay probing fails immediately once the extension revival window already expired", async () => {
	expect(
		await waitForRelayExtension(
			serve({ extensionSeen: true, uptimeMs: 100_000, disconnectedMs: 90_000, protoRelayVersion: VERSION }, 503),
		),
	).toBe("extension-gone");
	expect(
		await waitForRelayExtension(serve({ extensionSeen: false, uptimeMs: 100_000, protoRelayVersion: VERSION }, 503)),
	).toBe("no-extension");
});

test("an obsolete relay is blamed before a disconnected extension after the revival window", async () => {
	expect(
		await waitForRelayExtension(
			serve({ extensionSeen: true, uptimeMs: 100_000, disconnectedMs: 90_000, protoRelayVersion: "0.1.0" }, 503),
		),
	).toBe("outdated-relay");
});

test("cancelled relay probes reject rather than returning a usable or retryable outcome", async () => {
	await expect(waitForRelayExtension(serve(ready()), AbortSignal.abort())).rejects.toThrow();
});

test("extension notices report a stale running script but do not quote unrankable peer versions", async () => {
	const old = await relayExtensionNotice(serve(ready({ protoExtensionVersion: "0.1.0" })));
	expect(old).toContain("0.1.0");
	expect(await relayExtensionNotice(serve(ready({ protoExtensionVersion: VERSION })))).toBeNull();
	expect(isOlderProtoVersion("1.0.0", "build-local")).toBe(false);
	expect(isOlderProtoVersion("1.0.0 dirty", VERSION)).toBe(false);
});

test("extension hello claims only debugger attachments owned by that extension", async () => {
	const probed: number[] = [];
	const owned = await ownedDebuggerTabs(
		[{ tabId: 1, attached: true }, { tabId: 2, attached: true }, { tabId: 3, attached: false }, { attached: true }],
		async tabId => {
			probed.push(tabId);
			if (tabId === 2) throw new Error("Not attached by this extension");
		},
	);
	expect(probed).toEqual([1, 2]);
	expect(owned).toEqual([1]);
});
