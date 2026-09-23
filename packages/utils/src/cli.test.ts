import { expect, spyOn, test } from "bun:test";
import { Args, Command, type CommandEntry, Flags, run } from "./cli";

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

class ProbeCommand extends Command {
	static description = "Probe";
	static args = { key: Args.string(), value: Args.string({ multiple: true }) };
	static flags = { days: Flags.integer({ description: "Days" }), json: Flags.boolean({ char: "j" }) };
	static parsed: { flags: Record<string, unknown>; args: Record<string, unknown> } | undefined;

	async run(): Promise<void> {
		const { flags, args } = await this.parse(ProbeCommand);
		ProbeCommand.parsed = { flags, args };
	}
}

async function runProbe(argv: string[]): Promise<{ parsed: typeof ProbeCommand.parsed; stderr: string }> {
	ProbeCommand.parsed = undefined;
	const entry: CommandEntry = { name: "probe", load: async () => ProbeCommand as never };
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	const previousExitCode = process.exitCode;
	try {
		await run({ bin: "proto", version: "1.0.0", argv: ["probe", ...argv], commands: [entry] });
		return {
			parsed: ProbeCommand.parsed,
			stderr: stderr.mock.calls.flatMap(([text]) => String(text)).join(""),
		};
	} finally {
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	}
}

test("a negative number is a positional value, not a short-option cluster", async () => {
	const { parsed, stderr } = await runProbe(["set", "-42"]);
	expect(stderr).toBe("");
	expect(parsed?.args).toMatchObject({ key: "set", value: ["-42"] });
});

test("a negative number is accepted as a separated flag value, like its `=` form", async () => {
	const separated = await runProbe(["--days", "-5", "key"]);
	const equals = await runProbe(["--days=-5", "key"]);
	expect(separated.stderr).toBe("");
	expect(separated.parsed?.flags.days).toBe(-5);
	expect(separated.parsed?.flags).toEqual(equals.parsed?.flags as Record<string, unknown>);
});

test("`--` still passes any token through verbatim", async () => {
	const { parsed } = await runProbe(["key", "--", "-42", "--json"]);
	expect(parsed?.args.value).toEqual(["-42", "--json"]);
	expect(parsed?.flags.json).toBeUndefined();
});

test("a declared short flag wins over the negative-number reading", async () => {
	const { parsed } = await runProbe(["-j", "key"]);
	expect(parsed?.flags.json).toBe(true);
	expect(parsed?.args.key).toBe("key");
});

test("an unknown option is reported with the token the user typed and a runnable suggestion", async () => {
	const { parsed, stderr } = await runProbe(["key", "--42"]);
	expect(parsed).toBeUndefined();
	expect(stderr).toContain("Unknown option '--42'");
	expect(stderr).toContain(`proto probe key -- "--42"`);
	expect(stderr).not.toContain("Unknown option '4'");
});
