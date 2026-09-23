import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAdvisorConfigs, loadWatchdogConfigFile } from "./config";

// One malformed WATCHDOG.yml entry used to fail the whole document: every advisor in the file vanished, and the
// editor opened empty, so its next save wiped the healthy entries too.
describe("WATCHDOG.yml per-entry validation", () => {
	let project: string;
	let agentDir: string;

	beforeEach(async () => {
		project = await fs.mkdtemp(path.join(os.tmpdir(), "proto-advisor-config-"));
		await fs.mkdir(path.join(project, ".git"));
		// Empty agent dir so the user-level search path cannot pick up a real WATCHDOG.yml.
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-advisor-agentdir-"));
	});

	afterEach(async () => {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("keeps the healthy entries and names each dropped one, in discovery and in the editor", async () => {
		const file = path.join(project, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"advisors:",
				"  - name: Good",
				"  - name: Bad",
				"    enabled: not-a-boolean",
				"  - model: nameless/model",
			].join("\n"),
		);

		const discovered = await discoverAdvisorConfigs(project, agentDir);
		expect(discovered.advisors.map(advisor => advisor.name)).toEqual(["Good"]);
		expect(discovered.warnings).toHaveLength(2);
		expect(discovered.warnings[0]).toContain('advisor "Bad" dropped');
		expect(discovered.warnings[1]).toContain("advisor #3 dropped");

		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors.map(advisor => advisor.name)).toEqual(["Good"]);
		expect(doc.warnings).toEqual(discovered.warnings);
	});

	it.each([
		["unparseable YAML", "advisors: [unclosed", "failed to parse YAML"],
		["a non-mapping document", "- just\n- a\n- list\n", "expected a YAML mapping"],
		["a non-list advisors key", "advisors: not-a-list", "advisors must be a list"],
	])("reports %s instead of failing silently", async (_label, content, expected) => {
		const file = path.join(project, "WATCHDOG.yml");
		await Bun.write(file, content);

		const discovered = await discoverAdvisorConfigs(project, agentDir);
		expect(discovered.advisors).toEqual([]);
		expect(discovered.warnings).toHaveLength(1);
		expect(discovered.warnings[0]).toContain(expected);

		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings?.[0]).toContain(expected);
	});
});
