/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionError,
	ExtensionServiceTier,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";

describe("ExtensionRunner", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	// Shared immutable fixtures. ModelRegistry's constructor synchronously loads
	// every bundled model and rebuilds the canonical index (~100ms); these tests
	// never mutate the registry or auth storage, so build them once per file
	// instead of paying that cost in every beforeEach.
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-runner-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-runner-test-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
		tempDir.removeSync();
	});

	const loadTestExtensions = async (configuredPaths: string[] = []) => {
		const discoveredPaths = fs
			.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(entry => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")))
			.map(entry => path.join(extensionsDir, entry.name))
			.sort();
		const explicitPaths = configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath));
		const result = await loadExtensions([...discoveredPaths, ...explicitPaths], tempDir.path());
		const testRoots = [
			extensionsDir,
			...configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath)),
		];
		const isTestScoped = (candidate: string): boolean =>
			testRoots.some(root => {
				const relative = path.relative(path.resolve(root), path.resolve(candidate));
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
			});
		return {
			...result,
			extensions: result.extensions.filter(extension => isTestScoped(extension.path)),
			errors: result.errors.filter(error => isTestScoped(error.path)),
		};
	};

	it("reflects SessionManager.moveTo() changes instead of the constructor-time snapshot (/move)", async () => {
		const dirA = tempDir.join("dirA");
		const dirB = tempDir.join("dirB");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		const movableSessionManager = SessionManager.inMemory(dirA);

		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(result.extensions, result.runtime, dirA, movableSessionManager, modelRegistry);

		expect(runner.cwd).toBe(dirA);
		expect(runner.createContext().cwd).toBe(dirA);

		await movableSessionManager.moveTo(dirB);

		expect(runner.cwd).toBe(dirB);
		expect(runner.createContext().cwd).toBe(dirB);
	});

	it("exposes the initialized host mode to extension contexts", async () => {
		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const actions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		};
		const contextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		};

		expect(runner.createContext().mode).toBe("print");

		runner.initialize(actions, contextActions, undefined, undefined, "rpc");
		expect(runner.createContext().mode).toBe("rpc");

		runner.initialize(actions, contextActions, undefined, undefined, "json");
		expect(runner.createContext().mode).toBe("json");

		runner.initialize(actions, contextActions, undefined, undefined, "tui");
		expect(runner.createContext().mode).toBe("tui");
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects ctrl+q so it cannot shadow the app.message.followUp default (#1903)", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+q", {
						description: "Tries to bind the follow-up chord",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-q.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			// Contract: ctrl+q is reserved because it is now a default chord for
			// app.message.followUp. Without this guard, InputController registers
			// the extension shortcut first and the follow-up handler silently
			// overwrites it in the editor's custom-key map.
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+q")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects Alt+M so it cannot shadow the app.model.select default", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("alt+m", {
						description: "Tries to bind model select",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-model.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("alt+m")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"), expect.any(Object));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				export default function(pi) {
					const { Type } = pi.typebox;
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map(t => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map(c => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("prefers later-loaded explicit extensions for conflicting commands", async () => {
			const deployCommand = (description: string) => `
				export default function(pi) {
					pi.registerCommand("deploy", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;

			fs.writeFileSync(path.join(extensionsDir, "discovered-deploy.ts"), deployCommand("Discovered deploy"));
			const explicitExtensionPath = path.join(tempDir.path(), "explicit-deploy.ts");
			fs.writeFileSync(explicitExtensionPath, deployCommand("Explicit deploy"));

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const commands = runner.getRegisteredCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0]?.description).toBe("Explicit deploy");

			const command = runner.getCommand("deploy");
			expect(command?.description).toBe("Explicit deploy");
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("collects assistant thinking renderers", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerAssistantThinkingRenderer((context, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "thinking-renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.getAssistantThinkingRenderers().length).toBe(1);
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const flags = runner.getFlags();

			expect(flags.has("--my-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_provider_request chaining", () => {
		it("exposes the request model instead of the primary session model", async () => {
			const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
			const requestModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel || !requestModel) throw new Error("Expected bundled cross-provider models to exist");

			const extCode = `
				export default function(pi) {
					pi.on("before_provider_request", async (_event, ctx) => {
						const current = ctx.models.current();
						return {
							model: ctx.model && {
								provider: ctx.model.provider,
								id: ctx.model.id,
								api: ctx.model.api,
							},
							current: current && {
								provider: current.provider,
								id: current.id,
								api: current.api,
							},
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "request-model.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => primaryModel,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			const payload = await runner.emitBeforeProviderRequest({}, requestModel);

			const expected = {
				provider: requestModel.provider,
				id: requestModel.id,
				api: requestModel.api,
			};
			expect(payload).toEqual({ model: expected, current: expected });
		});

		it("chains payload replacements across handlers in load order", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext1"] };
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext2"] };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const payload = await runner.emitBeforeProviderRequest({ chain: ["base"] });
			expect(payload).toEqual({ chain: ["base", "ext1", "ext2"] });
		});

		it("keeps chaining after handler errors", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async () => {
						throw new Error("payload failed");
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { preserved?: boolean };
						return { ...payload, preserved: true };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-error.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-ok.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			const payload = await runner.emitBeforeProviderRequest({ original: true });
			expect(payload).toEqual({ original: true, preserved: true });
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("before_provider_request");
			expect(errors[0]?.error).toContain("payload failed");
		});
	});

	describe("after_provider_response", () => {
		it("calls handlers with response metadata and reports handler errors without throwing", async () => {
			const eventsPath = path.join(tempDir.path(), "after-provider-response-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							status: event.status,
							headers: event.headers,
							requestId: event.requestId,
							metadata: event.metadata,
						}) + "\\n",
					);
				});

				pi.on("after_provider_response", async () => {
					throw new Error("response failed");
				});

				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({ afterError: event.status }) + "\\n",
					);
				});
			}
		`;
			fs.writeFileSync(path.join(extensionsDir, "after-provider-response.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emitAfterProviderResponse({
				status: 202,
				headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
				requestId: "req_123",
				metadata: { provider: "test" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					status: 202,
					headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
					requestId: "req_123",
					metadata: { provider: "test" },
				},
				{ afterError: 202 },
			]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("after_provider_response");
			expect(errors[0]?.error).toContain("response failed");
		});

		it("exposes the response model instead of the primary session model", async () => {
			const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
			const requestModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel || !requestModel) throw new Error("Expected bundled cross-provider models to exist");

			const eventsPath = path.join(tempDir.path(), "after-provider-response-model.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("after_provider_response", async (_event, ctx) => {
						const current = ctx.models.current();
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id },
								current: current && { provider: current.provider, id: current.id },
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "after-response-model.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => primaryModel,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emitAfterProviderResponse(
				{ status: 402, headers: {}, requestId: "req_402", metadata: { provider: requestModel.provider } },
				requestModel,
			);

			const expected = { provider: requestModel.provider, id: requestModel.id };
			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ model: expected, current: expected }]);
		});
	});

	describe("session_stop", () => {
		it("invokes handlers with completed main-session messages and returns continuation feedback", async () => {
			const eventsPath = path.join(tempDir.path(), "session-stop-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("session_stop", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							type: event.type,
							messages: event.messages,
							turn_id: event.turn_id,
							last_assistant_message: event.last_assistant_message,
							session_id: event.session_id,
							session_file: event.session_file,
							stop_hook_active: event.stop_hook_active,
						}) + "\\n",
					);
					return { continue: true, additionalContext: "Run one more pass." };
				});
			}
		`;
			await Bun.write(path.join(extensionsDir, "session-stop.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			const stopResult = await runner.emitSessionStop({
				messages: [completedMessage],
				turn_id: 2,
				last_assistant_message: completedMessage,
				session_id: "session-123",
				session_file: "/tmp/session.jsonl",
				stop_hook_active: false,
				signal: new AbortController().signal,
			});

			const events = (await Bun.file(eventsPath).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					type: "session_stop",
					messages: [completedMessage],
					turn_id: 2,
					last_assistant_message: completedMessage,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				},
			]);
			expect(stopResult).toEqual({ continue: true, additionalContext: "Run one more pass." });
		});

		it("skips cancelled handlers, releases in-flight handlers, and preserves timeout errors", async () => {
			const extensionPath = path.join(tempDir.path(), "cancel-session-stop.ts");
			const startedPath = path.join(tempDir.path(), "session-stop-started.txt");
			await Bun.write(
				extensionPath,
				`
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("session_stop", async () => {
						fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: ExtensionError[] = [];
			runner.onError(error => errors.push(error));
			testSetExtensionHandlerTimeoutMs(100);
			const controller = new AbortController();
			const preAborted = new AbortController();
			preAborted.abort();
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: preAborted.signal,
				}),
			).resolves.toBeUndefined();
			expect(await Bun.file(startedPath).exists()).toBe(false);

			const emission = runner.emitSessionStop({
				messages: [],
				turn_id: 0,
				session_id: "session-123",
				stop_hook_active: false,
				signal: controller.signal,
			});
			expect(await Bun.file(startedPath).text()).toBe("started");
			controller.abort();

			await expect(emission).resolves.toBeUndefined();
			expect(errors).toEqual([]);

			// A non-cancelled handler still exercises the production timer and reports its timeout.
			testSetExtensionHandlerTimeoutMs(10);
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 1,
					session_id: "session-123",
					stop_hook_active: false,
					signal: new AbortController().signal,
				}),
			).resolves.toBeUndefined();
			expect(errors).toEqual([
				{
					extensionPath,
					event: "session_stop",
					error: "handler timed out after 10ms",
				},
			]);
		});

		it("observes a session_stop signal aborted synchronously by the handler", async () => {
			const extensionPath = path.join(tempDir.path(), "self-cancel-session-stop.ts");
			await Bun.write(
				extensionPath,
				`
				export default function(pi) {
					pi.on("session_stop", async (_event, ctx) => {
						ctx.abort();
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const controller = new AbortController();
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => controller.abort(),
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);
			vi.useFakeTimers();
			try {
				testSetExtensionHandlerTimeoutMs(100);
				const emission = runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: controller.signal,
				});
				let settled = false;
				void emission.then(() => {
					settled = true;
				});
				for (let attempts = 0; attempts < 10 && !settled; attempts++) {
					await Promise.resolve();
				}

				expect(controller.signal.aborted).toBe(true);
				expect(settled).toBe(true);
				await emission;
			} finally {
				vi.useRealTimers();
			}
		});
		it("continues to later handlers after empty continuation feedback", async () => {
			await Bun.write(
				path.join(extensionsDir, "session-stop-empty.ts"),
				`
				export default function(pi) {
					pi.on("session_stop", async () => ({ continue: true }));
					pi.on("session_stop", async () => ({ decision: "block", reason: "Continue from second handler." }));
				}
			`,
			);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			await expect(
				runner.emitSessionStop({
					messages: [completedMessage],
					turn_id: 0,
					last_assistant_message: completedMessage,
					signal: new AbortController().signal,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				}),
			).resolves.toEqual({ decision: "block", reason: "Continue from second handler." });
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("tool_result rewrite of thrown failures", () => {
		const throwingTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "always throws",
			parameters: {} as never,
			execute: async () => {
				throw new Error("original explosion");
			},
		};

		const okTool: AgentTool = {
			name: "fine",
			label: "Fine",
			description: "always succeeds",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text" as const, text: "success" }] }),
		};

		const firstText = (result: { content: readonly (TextContent | ImageContent)[] }): string | undefined => {
			const block = result.content[0];
			return block?.type === "text" ? block.text : undefined;
		};

		const runnerFor = async (extCode: string): Promise<ExtensionRunner> => {
			fs.writeFileSync(path.join(extensionsDir, "rewrite.ts"), extCode);
			const result = await loadTestExtensions();
			return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
		};

		it("surfaces replacement content while keeping the call an error", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", (event) => {
						if (!event.isError) return;
						return {
							content: [{ type: "text", text: "Enriched recovery guidance" }],
							details: { enriched: true },
							isError: true,
						};
					});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			const res = await wrapper.execute("call-rewrite", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("Enriched recovery guidance");
			expect(res.isError).toBe(true);
			expect(res.details).toEqual({ enriched: true });
		});

		it("preserves the original exception when no handler modifies the result", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", () => {});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			await expect(wrapper.execute("call-untouched", {} as never, undefined, undefined, undefined)).rejects.toThrow(
				"original explosion",
			);
		});

		it("converts a failure to success when a handler clears isError", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", (event) => {
						if (!event.isError) return;
						return { content: [{ type: "text", text: "recovered" }], isError: false };
					});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			const res = await wrapper.execute("call-cleared", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("recovered");
			expect(res.isError).toBeUndefined();
		});

		it("marks a successful result as an error when a handler sets isError", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", () => ({
						content: [{ type: "text", text: "now failing" }],
						isError: true,
					}));
				}
			`);
			const wrapper = new ExtensionToolWrapper(okTool, runner);
			const res = await wrapper.execute("call-flagged", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("now failing");
			expect(res.isError).toBe(true);
		});
	});

	describe("handler timeouts", () => {
		const initializeRunner = (runner: ExtensionRunner, uiContext: ExtensionUIContext): void => {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
				undefined,
				uiContext,
			);
		};

		it("times out session_start handlers, emits an error, and continues to sibling extensions", async () => {
			const hangExtensionPath = path.join(tempDir.path(), "hang-session-start.ts");
			const fastExtensionPath = path.join(tempDir.path(), "fast-session-start.ts");
			const markerPath = path.join(tempDir.path(), "session-start-marker.txt");
			fs.writeFileSync(
				hangExtensionPath,
				`
					export default function(pi) {
						pi.on("session_start", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);
			fs.writeFileSync(
				fastExtensionPath,
				`
					import * as fs from "node:fs";

					export default function(pi) {
						pi.on("session_start", async () => {
							fs.appendFileSync(${JSON.stringify(markerPath)}, "fast\\n");
						});
					}
				`,
			);

			const result = await loadTestExtensions([hangExtensionPath, fastExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});
			testSetExtensionHandlerTimeoutMs(10);

			const startedAt = performance.now();
			await runner.emit({ type: "session_start" });
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(150);
			expect(fs.readFileSync(markerPath, "utf8")).toBe("fast\n");
			expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
				extensionPath: hangExtensionPath,
				event: "session_start",
				timeoutMs: 10,
			});
			expect(errors).toEqual([
				{
					extensionPath: hangExtensionPath,
					event: "session_start",
					error: "handler timed out after 10ms",
				},
			]);

			warnSpy.mockRestore();
		});

		it("keeps a stalled registration inside the session_shutdown deadline", async () => {
			const extensionPath = path.join(tempDir.path(), "shutdown-registration.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("session_shutdown", () => {
							const { Type } = pi.typebox;
							pi.registerTool({
								name: "shutdown_tool",
								label: "Shutdown Tool",
								description: "Registered while shutting down.",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(() => Promise.withResolvers<void>().promise);
			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			testSetSessionShutdownHandlerTimeoutMs(10);

			const startedAt = performance.now();
			await runner.emit({ type: "session_shutdown" });
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(150);
			expect(errors).toContainEqual({
				extensionPath,
				event: "session_shutdown",
				error: "handler timed out after 10ms",
			});
		});

		it("uses the configured tool_call timeout and fails closed so a hung extension cannot block execution (#3948)", async () => {
			const hangExtensionPath = path.join(tempDir.path(), "hang-tool-call.ts");
			fs.writeFileSync(
				hangExtensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);

			const result = await loadTestExtensions([hangExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": 10 }),
			);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});
			const executeCalls: unknown[] = [];
			const tool: AgentTool = {
				name: "sleepy",
				label: "Sleepy",
				description: "records execute() invocations",
				parameters: Type.Object({}),
				strict: true,
				execute: async (_id, params) => {
					executeCalls.push(params);
					return { content: [{ type: "text", text: "ran" }] };
				},
			};
			const wrapped = new ExtensionToolWrapper(tool, runner);

			const startedAt = performance.now();
			await expect(wrapped.execute("tool-call-id", {})).rejects.toThrow(
				`Extension ${hangExtensionPath} timed out after 10ms`,
			);
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(500);
			// Fail-closed: the underlying tool MUST NOT run when a gate handler timed out.
			expect(executeCalls).toEqual([]);
			expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
				extensionPath: hangExtensionPath,
				event: "tool_call",
				timeoutMs: 10,
			});
			expect(errors).toEqual([
				{
					extensionPath: hangExtensionPath,
					event: "tool_call",
					error: "handler timed out after 10ms",
				},
			]);

			warnSpy.mockRestore();
		});

		it("falls back to the default tool_call timeout for invalid configured values", async () => {
			const extensionPath = path.join(tempDir.path(), "invalid-timeout-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);
			const loaded = await loadTestExtensions([extensionPath]);

			vi.useFakeTimers();
			try {
				for (const configuredTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
					const runner = new ExtensionRunner(
						loaded.extensions,
						loaded.runtime,
						tempDir.path(),
						sessionManager,
						modelRegistry,
						Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": configuredTimeout }),
					);
					let settled = false;
					const decision = runner
						.emitToolCall({
							type: "tool_call",
							toolName: "guarded",
							toolCallId: "invalid-timeout-call",
							input: {},
						})
						.then(result => {
							settled = true;
							return result;
						});

					vi.advanceTimersByTime(EXTENSION_HANDLER_TIMEOUT_MS - 1);
					expect(settled).toBe(false);

					vi.advanceTimersByTime(1);
					await Promise.resolve();
					await Promise.resolve();
					vi.advanceTimersByTime(0);
					expect(await decision).toEqual({
						block: true,
						reason: `Extension ${extensionPath} timed out after ${EXTENSION_HANDLER_TIMEOUT_MS}ms`,
					});
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it("fails closed when a tool_call handler registration cannot activate", async () => {
			const extensionPath = path.join(tempDir.path(), "tool-call-registration.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", () => {
							const { Type } = pi.typebox;
							pi.registerTool({
								name: "tool_call_registered",
								label: "Tool Call Registered",
								description: "Registered from a tool-call hook.",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(async () => {
				throw new Error("expected tool-call registration failure");
			});
			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			const executeCalls: unknown[] = [];
			const wrapped = new ExtensionToolWrapper(
				{
					name: "gated",
					label: "Gated",
					description: "Must not execute after a gate registration fails.",
					parameters: Type.Object({}),
					execute: async (_id, params) => {
						executeCalls.push(params);
						return { content: [{ type: "text", text: "ran" }] };
					},
				},
				runner,
			);

			await expect(wrapped.execute("tool-call-id", {})).rejects.toThrow(
				`Extension ${extensionPath} failed: expected tool-call registration failure`,
			);
			expect(executeCalls).toEqual([]);
			expect(errors).toContainEqual({
				extensionPath,
				event: "tool_call",
				error: "expected tool-call registration failure",
				stack: expect.any(String),
			});
		});

		it("does not charge detached registrations to unrelated tool-call handlers", async () => {
			const extensionPath = path.join(tempDir.path(), "detached-registration-barrier.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						const { Type } = pi.typebox;
						pi.registerTool({
							name: "detached_source_tool",
							label: "Detached Source Tool",
							description: "Provides a registration event for the detached barrier test.",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.on("tool_call", () => undefined);
					}
				`,
			);

			const loaded = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(() => Promise.withResolvers<void>().promise);
			const extension = loaded.extensions[0];
			const registrationListener = extension?.toolRegistrationListeners?.values().next().value;
			if (!registrationListener) throw new Error("expected registration listener");
			registrationListener("detached_source_tool");

			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			testSetExtensionHandlerTimeoutMs(10);

			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: "unrelated",
				toolCallId: "unrelated-call",
				input: {},
			});

			expect(result).toBeUndefined();
			expect(errors).toEqual([]);
		});

		it("pauses a tool_call handler timeout during standard and custom dialogs, then resumes its budget", async () => {
			const extensionPath = path.join(tempDir.path(), "confirm-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							ctx.ui.notify("Waiting for confirmation");
							await new Promise(resolve => setTimeout(resolve, 8));
							await ctx.ui.confirm("High-risk command", "Allow this command?");
							await ctx.ui.custom(() => ({}));
							ctx.ui.notify("Custom settled");
							await Promise.withResolvers().promise;
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const dialog = Promise.withResolvers<boolean>();
			const handlerStarted = Promise.withResolvers<void>();
			const confirmationStarted = Promise.withResolvers<void>();
			const customStarted = Promise.withResolvers<void>();
			const customCompleted = Promise.withResolvers<void>();
			let dialogSignal: AbortSignal | undefined;
			const notify: ExtensionUIContext["notify"] = message => {
				if (message === "Waiting for confirmation") handlerStarted.resolve();
				if (message === "Custom settled") customCompleted.resolve();
			};
			const confirm: ExtensionUIContext["confirm"] = async (_title, _message, dialogOptions) => {
				dialogSignal = dialogOptions?.signal;
				confirmationStarted.resolve();
				dialogSignal?.addEventListener("abort", () => dialog.resolve(false), { once: true });
				return await dialog.promise;
			};
			const customDialog = Promise.withResolvers<void>();
			let customSignal: AbortSignal | undefined;
			const custom: ExtensionUIContext["custom"] = async <T>(...args: Parameters<ExtensionUIContext["custom"]>) => {
				customSignal = args[1]?.signal;
				await args[0](undefined as never, undefined as never, undefined as never, () => {});
				customStarted.resolve();
				await customDialog.promise;
				return undefined as T;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				confirm: { value: confirm },
				custom: { value: custom },
				notify: { value: notify },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			vi.useFakeTimers();
			let now = 0;
			const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => now);
			try {
				testSetExtensionHandlerTimeoutMs(25);

				const tool: AgentTool = {
					name: "guarded",
					label: "Guarded",
					description: "must not execute after the extension gate times out",
					parameters: Type.Object({}),
					strict: true,
					execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
				};
				const wrapped = new ExtensionToolWrapper(tool, runner);

				const execution = wrapped.execute("tool-call-id", {});
				await handlerStarted.promise;
				expect(dialogSignal).toBeUndefined();

				now = 8;
				vi.advanceTimersByTime(8);
				await confirmationStarted.promise;
				expect(dialogSignal).toBeDefined();

				now = 108;
				vi.advanceTimersByTime(100);
				expect(dialogSignal?.aborted).toBe(false);

				dialog.resolve(true);
				await customStarted.promise;
				expect(customSignal).toBeDefined();
				expect(customSignal?.aborted).toBe(false);

				now = 208;
				vi.advanceTimersByTime(100);
				expect(customSignal?.aborted).toBe(false);

				customDialog.resolve();
				await customCompleted.promise;

				now = 225;
				vi.advanceTimersByTime(17);
				await Promise.resolve();
				await Promise.resolve();
				vi.advanceTimersByTime(0);
				await expect(execution).rejects.toThrow(`Extension ${extensionPath} timed out after 25ms`);
			} finally {
				performanceNow.mockRestore();
				vi.useRealTimers();
			}
		});

		it("charges async custom factory setup to the handler timeout until the dialog is presented", async () => {
			const extensionPath = path.join(tempDir.path(), "pending-custom-factory.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							await ctx.ui.custom(async () => {
								ctx.ui.notify("Factory started");
								await Promise.withResolvers().promise;
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const factoryStarted = Promise.withResolvers<void>();
			const notify: ExtensionUIContext["notify"] = message => {
				if (message === "Factory started") factoryStarted.resolve();
			};
			const custom: ExtensionUIContext["custom"] = async <T>(...args: Parameters<ExtensionUIContext["custom"]>) => {
				await args[0](undefined as never, undefined as never, undefined as never, () => {});
				return undefined as T;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				custom: { value: custom },
				notify: { value: notify },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			vi.useFakeTimers();
			try {
				testSetExtensionHandlerTimeoutMs(10);
				let settled = false;
				const decision = runner
					.emitToolCall({
						type: "tool_call",
						toolName: "guarded",
						toolCallId: "pending-custom-factory",
						input: {},
					})
					.then(value => {
						settled = true;
						return value;
					});

				await factoryStarted.promise;
				vi.advanceTimersByTime(10);
				for (let i = 0; i < 3; i++) await Promise.resolve();
				vi.advanceTimersByTime(0);
				for (let i = 0; i < 5; i++) await Promise.resolve();

				expect(settled).toBe(true);
				expect(await decision).toEqual({
					block: true,
					reason: `Extension ${extensionPath} timed out after 10ms`,
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels a pending confirmation and blocks tool execution when the outer dispatch aborts (#4223)", async () => {
			const extensionPath = path.join(tempDir.path(), "confirm-abort-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							await ctx.ui.confirm("High-risk command", "Allow this command?");
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			let dialogSignal: AbortSignal | undefined;
			const dialog = Promise.withResolvers<boolean>();
			const confirmationStarted = Promise.withResolvers<void>();
			const confirm: ExtensionUIContext["confirm"] = async (_title, _message, dialogOptions) => {
				dialogSignal = dialogOptions?.signal;
				confirmationStarted.resolve();
				dialogSignal?.addEventListener("abort", () => dialog.resolve(false), { once: true });
				return await dialog.promise;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				confirm: { value: confirm },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			let executed = false;

			const tool: AgentTool = {
				name: "guarded",
				label: "Guarded",
				description: "must not execute after the dispatch aborts",
				parameters: Type.Object({}),
				strict: true,
				execute: async () => {
					executed = true;
					return { content: [{ type: "text", text: "ran" }] };
				},
			};
			const wrapped = new ExtensionToolWrapper(tool, runner);

			const controller = new AbortController();
			const execution = wrapped.execute("tool-call-id", {} as never, controller.signal);
			await confirmationStarted.promise;

			expect(dialogSignal).toBeDefined();
			expect(dialogSignal?.aborted).toBe(false);

			controller.abort();
			await expect(execution).rejects.toThrow();

			expect(dialogSignal?.aborted).toBe(true);
			expect(executed).toBe(false);
		});
	});

	describe("service tier API", () => {
		it("restricts tiers to values supported by each provider family", () => {
			expectTypeOf<"scale">().toExtend<ExtensionServiceTier<"openai">>();
			expectTypeOf<"flex">().toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"priority">().toExtend<ExtensionServiceTier<"anthropic">>();
			expectTypeOf<"scale">().not.toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"flex">().not.toExtend<ExtensionServiceTier<"anthropic">>();
		});

		it("returns a detached snapshot, forwards valid changes, and rejects invalid family tiers", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", () => {
						const tiers = pi.getServiceTiers();
						tiers.openai = "scale";
						pi.appendEntry("service-tier-snapshot", tiers);
						pi.setServiceTier("google", "flex");
						pi.setServiceTier("openai", undefined);
					});
					pi.on("session_start", () => {
						pi.setServiceTier("anthropic", "scale");
					});
					pi.on("session_start", () => {
						pi.setServiceTier("bogus", "priority");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "service-tiers.ts");
			await Bun.write(explicitExtensionPath, extCode);
			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const serviceTiers = { openai: "priority" as const };
			const snapshots: unknown[] = [];
			const setCalls: Array<[string, unknown]> = [];
			const errors: string[] = [];
			runner.onError(error => {
				errors.push(error.error);
			});
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: (_customType, data) => {
						snapshots.push(data);
					},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getServiceTiers: () => serviceTiers,
					setServiceTier: (family, tier) => {
						setCalls.push([family, tier]);
					},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(serviceTiers).toEqual({ openai: "priority" });
			expect(snapshots).toEqual([{ openai: "scale" }]);
			expect(setCalls).toEqual([
				["google", "flex"],
				["openai", undefined],
			]);
			expect(errors).toHaveLength(2);
			expect(errors[0]).toContain('Invalid service tier "scale" for family "anthropic"');
			expect(errors[1]).toContain('Invalid service tier "priority" for family "bogus"');
		});
	});

	describe("session name API", () => {
		it("lets extensions read and set the session name after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async () => {
						if (pi.getSessionName() !== undefined) {
							throw new Error("expected unnamed session");
						}
						await pi.setSessionName("Named by extension");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async name => {
						await sessionManager.setSessionName(name);
					},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(sessionManager.getSessionName()).toBe("Named by extension");
			expect(sessionManager.getHeader()?.title).toBe("Named by extension");
		});

		it("keeps session naming unavailable during extension load", async () => {
			const extCode = `
				export default function(pi) {
					pi.getSessionName();
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name-load.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const loadError = result.errors.find(error => error.path.includes("session-name-load.ts"));

			expect(loadError).toBeDefined();
			expect(loadError?.error).toContain("Extension runtime not initialized");
		});
	});
});
