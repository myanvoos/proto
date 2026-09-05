import { describe, expect, test } from "bun:test";
import { parseConductorObjective } from "./program-tool";

const validObjective = [
	"## Objective",
	"Deliver the requested change.",
	"",
	"## Success criteria",
	"1. Each milestone has evidence.",
	"",
	"## Verification",
	"`bun test` — runs the focused tests",
	"`bun check` — checks the repository",
	"",
	"## Boundaries",
	"Only the requested package.",
	"",
	"## Stop conditions",
	"Stop after three failed attempts.",
].join("\n");

describe("parseConductorObjective", () => {
	test("extracts exact verification commands from the five-section contract", () => {
		expect(parseConductorObjective(validObjective).verificationCommands).toEqual(["bun test", "bun check"]);
	});

	test("rejects extra or malformed headings", () => {
		expect(() => parseConductorObjective(validObjective.replace("## Objective", "### Objective"))).toThrow();
		expect(() =>
			parseConductorObjective(validObjective.replace("## Boundaries", "## Extra\ntext\n## Boundaries")),
		).toThrow();
	});

	test("rejects an empty or prose-only verification section", () => {
		expect(() =>
			parseConductorObjective(
				validObjective.replace("`bun test` — runs the focused tests\n`bun check` — checks the repository", ""),
			),
		).toThrow();
		expect(() =>
			parseConductorObjective(
				validObjective.replace("`bun test` — runs the focused tests", "Run the checks somehow"),
			),
		).toThrow();
	});
});
