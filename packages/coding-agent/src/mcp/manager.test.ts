import { afterEach, expect, test } from "bun:test";
import { MCPManager } from "./manager";

const managers: MCPManager[] = [];

afterEach(async () => {
	while (managers.length > 0) await managers.pop()?.dispose();
	MCPManager.resetForTests();
});

test("dispose releases the manager singleton and connection state", async () => {
	const manager = new MCPManager(process.cwd());
	managers.push(manager);
	manager.setOnToolsChanged(() => {});
	manager.setOnResourcesChanged(() => {});
	manager.setOnPromptsChanged(() => {});
	manager.addNotificationListener(() => {});
	MCPManager.setInstance(manager);

	await manager.dispose();

	expect(MCPManager.instance()).toBeUndefined();
	expect(manager.getConnectedServers()).toEqual([]);
	expect(manager.getAllServerNames()).toEqual([]);
	expect(manager.getNotificationState()).toEqual({ enabled: false, subscriptions: new Map() });
});

test("disconnectAll keeps the singleton for a live reconnect", async () => {
	const manager = new MCPManager(process.cwd());
	managers.push(manager);
	MCPManager.setInstance(manager);

	await manager.disconnectAll();

	expect(MCPManager.instance()).toBe(manager);
});
