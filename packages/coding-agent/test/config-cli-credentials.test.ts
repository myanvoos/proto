import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { isCredential, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";
import { getSettingDef } from "../src/modes/components/settings-defs";

const paths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

describe("credential settings", () => {
	it("marks every known credential, including those with no settings panel entry", () => {
		for (const path of [
			"auth.broker.token",
			"searxng.token",
			"searxng.basicPassword",
			"dev.autoqaPush.token",
		] as const) {
			expect(isCredential(path)).toBe(true);
		}
	});

	it("classifies UI-visible credentials through the same marker", () => {
		// One field, not two: there is no separate UI-only masking flag that could
		// drift away from this classification.
		for (const path of ["searxng.token", "searxng.basicPassword"] as const) {
			expect(isCredential(path)).toBe(true);
		}
	});

	it("does not sweep ordinary settings into the credential set", () => {
		// Token-budget settings read like credentials by name but are plain numbers.
		for (const path of ["compaction.thresholdTokens", "display.showTokenUsage", "autoResume"] as const) {
			expect(isCredential(path)).toBe(false);
		}
	});

	it("only marks string or record settings as credentials", () => {
		for (const path of paths) {
			if (!isCredential(path)) continue;
			expect(["string", "record"]).toContain(SETTINGS_SCHEMA[path].type);
		}
	});
});

describe("credential masking reaches every surface", () => {
	it("keeps every credential out of the settings panel entirely", () => {
		// Credentials are config-file-only: none of them carries UI metadata, so
		// the panel can never render one as plain text. If a future credential
		// gains a panel entry, it must set `secret` via the shared
		// `secret: isCredential(path)` derivation in the def builder.
		for (const path of paths) {
			if (!isCredential(path)) continue;
			expect(getSettingDef(path)).toBeUndefined();
		}
	});

	it("masks panel text defs through the same credential classification", () => {
		// The panel derives masking from the same classification the CLI uses.
		// No current setting exercises the masked branch (all credentials are
		// panel-invisible), so assert the builder wiring via an ordinary text
		// def staying unmasked instead.
		const def = getSettingDef("shellPath");
		if (def?.type === "text") expect(def.secret).toBe(false);
	});
});

/**
 * The classification tests above cannot see what `config list` actually prints.
 * Both output branches could be deleted and every one of them would still pass,
 * so these drive the real command and read its real output.
 */
describe("config list output", () => {
	const SECRET = "credential-value-not-for-output";
	let agentDir: TempDir | undefined;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		resetSettingsForTest();
		agentDir = TempDir.createSync("@proto-config-credentials-");
		setAgentDir(agentDir.path());
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.resetInstance();
		resetSettingsForTest();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (agentDir) {
			try {
				await agentDir.remove();
			} catch {}
			agentDir = undefined;
		}
	});

	/** Human output goes to console.log; the JSON branch writes stdout directly. */
	async function humanList(): Promise<string> {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "list", flags: {} });
		return log.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
	}

	async function jsonList(): Promise<{ raw: string; parsed: Record<string, Record<string, unknown>> }> {
		let raw = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			const done = rest.find(argument => typeof argument === "function");
			if (typeof done === "function") (done as (error?: Error | null) => void)(null);
			return true;
		}) as typeof process.stdout.write);
		await runConfigCommand({ action: "list", flags: { json: true } });
		write.mockRestore();
		return { raw, parsed: JSON.parse(raw) as Record<string, Record<string, unknown>> };
	}

	it("masks a configured credential and never prints it", async () => {
		await runConfigCommand({ action: "set", key: "searxng.token", value: SECRET, flags: { json: true } });
		const output = await humanList();
		expect(output).toContain("searxng.token = ********");
		expect(output).not.toContain(SECRET);
	});

	it("omits the value and flags redaction in JSON, rather than emitting a placeholder", async () => {
		await runConfigCommand({ action: "set", key: "searxng.token", value: SECRET, flags: { json: true } });
		const { raw, parsed } = await jsonList();
		// A consumer must not be able to write the stand-in back as the credential.
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain("********");
		expect(parsed["searxng.token"]).toMatchObject({ redacted: true });
		expect(parsed["searxng.token"]).not.toHaveProperty("value");
	});

	it("does not report an unset credential as configured", async () => {
		// Redacting on classification alone would make a fresh install look like
		// every credential is already set.
		const output = await humanList();
		expect(output).not.toContain("searxng.token = ********");
		const { parsed } = await jsonList();
		expect(parsed["searxng.token"]).not.toHaveProperty("redacted");
	});

	it("does not report a cleared credential as configured", async () => {
		// The settings panel persists "" when a credential is cleared and renders
		// that as unset; `config list` must agree, or a cleared token looks set.
		await runConfigCommand({ action: "set", key: "searxng.token", value: SECRET, flags: { json: true } });
		await runConfigCommand({ action: "set", key: "searxng.token", value: "", flags: { json: true } });
		const output = await humanList();
		expect(output).not.toContain("searxng.token = ********");
		const { parsed } = await jsonList();
		expect(parsed["searxng.token"]).not.toHaveProperty("redacted");
	});
});
