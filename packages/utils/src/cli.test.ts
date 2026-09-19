import { expect, spyOn, test } from "bun:test";
import { Args, type CommandEntry, Flags, run } from "./cli";

test("command help renders metadata without loading the operational command", async () => {
	let loads = 0;
	const entry: CommandEntry = {
		name: "probe",
		help: {
			description: "Probe command",
			args: { target: Args.string({ required: true, description: "Target path" }) },
			flags: { json: Flags.boolean({ description: "Output JSON" }) },
		},
		load: async () => {
			loads++;
			throw new Error("operational command must not load for help");
		},
	};
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	let output = "";
	try {
		await run({ bin: "proto", version: "1.0.0", argv: ["probe", "--help"], commands: [entry] });
		output = stdout.mock.calls.flatMap(([text]) => String(text)).join("");
	} finally {
		stdout.mockRestore();
	}

	expect(loads).toBe(0);
	expect(output).toContain("Target path");
});

test("root command version prints without loading the root command", async () => {
	let loads = 0;
	const entry: CommandEntry = {
		name: "launch",
		load: async () => {
			loads++;
			throw new Error("launch operational graph must not load for --version");
		},
	};
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	let output = "";
	try {
		await run({
			bin: "proto",
			version: "1.0.0",
			argv: ["launch", "--version"],
			commands: [entry],
			rootCommand: "launch",
		});
		output = stdout.mock.calls.flatMap(([text]) => String(text)).join("");
	} finally {
		stdout.mockRestore();
	}

	expect(loads).toBe(0);
	expect(output).toBe("1.0.0\n");
});

test("without rootCommand the version fast path does not apply", async () => {
	let loads = 0;
	const entry: CommandEntry = {
		name: "launch",
		load: async () => {
			loads++;
			throw new Error("loaded");
		},
	};
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		await expect(
			run({ bin: "proto", version: "1.0.0", argv: ["launch", "--version"], commands: [entry] }),
		).rejects.toThrow("loaded");
	} finally {
		stdout.mockRestore();
	}

	expect(loads).toBe(1);
});
