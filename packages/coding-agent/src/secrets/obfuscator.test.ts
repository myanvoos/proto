import { describe, expect, it, spyOn } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { obfuscateMessages } from "./message-transform";
import { SecretObfuscator } from "./obfuscator";
import { compileSecretRegex } from "./regex";
import { regexRematchesInContext } from "./replacement";

describe("Unicode empty regex matches", () => {
	// A broken scan loops synchronously forever, so bound the real RegExp calls
	// and surface the lack of progress as a failure instead of hanging the suite.
	function finishScan<T>(scan: () => T): T {
		const exec = RegExp.prototype.exec;
		let emptyMatches = 0;
		const execSpy = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text: string) {
			const match = exec.call(this, text);
			if (match?.[0] === "" && (this.unicode || this.unicodeSets)) {
				emptyMatches++;
				if (emptyMatches > 64) throw new Error("Unicode empty-match scan stopped making progress");
			}
			return match;
		});
		try {
			return scan();
		} finally {
			execSpy.mockRestore();
		}
	}

	it("finishes secret-value collection in both Unicode modes", () => {
		for (const flags of ["u", "v"]) {
			const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?:secret)?", flags }]);
			expect(
				finishScan(() => obfuscator.obfuscate("😀")),
				flags,
			).toBe("😀");
		}
	});

	it("finishes match collection before redacting a later secret", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?:SECRET123)?", flags: "u" }]);
		const input = "😀SECRET123";
		const output = finishScan(() => obfuscator.obfuscate(input));
		expect(output).not.toContain("SECRET123");
		expect(obfuscator.deobfuscate(output)).toBe(input);
	});

	it("finishes prefix scans without stranding the cut inside a code point", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?:SECRET123)?", flags: "u" }]);
		expect(finishScan(() => obfuscator.redactionPrefixEnd("😀SECRET123", 1))).toBe(1);
	});

	it("finishes replacement-context probes around an earlier supplementary character", () => {
		const regex = compileSecretRegex("(?:TOKEN)?", "u");
		const matches = finishScan(() => regexRematchesInContext("B", regex, { text: "😀A", start: 2, end: 3 }));
		expect(matches).toBe(false);
	});
});

describe("developer messages", () => {
	it("redacts agent-attributed developer messages like tool results", () => {
		const secret = "sdk-secret-token-123456";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const messages: Message[] = [
			{
				role: "developer",
				attribution: "agent",
				content: `background job output ${secret}`,
				timestamp: 1,
			},
		];
		const obfuscated = obfuscateMessages(obfuscator, messages);
		expect(JSON.stringify(obfuscated)).not.toContain(secret);
		expect(obfuscator.deobfuscate(JSON.stringify(obfuscated))).toContain(secret);
	});
});
