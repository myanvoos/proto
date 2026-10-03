import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openCloexecSync } from "./fs-open";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Bun.spawn closes stray descriptors itself, so the kernel's view of the flag is the observable contract.
test.skipIf(process.platform !== "linux")("opens descriptors with close-on-exec set", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-fs-open-"));
	tempDirs.push(dir);
	const fd = openCloexecSync(
		path.join(dir, "held.log"),
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
	);
	try {
		const flags = Number.parseInt(
			/flags:\s*([0-7]+)/.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1] ?? "0",
			8,
		);
		expect(flags & 0o2000000).toBe(0o2000000);
		expect(flags & fs.constants.O_APPEND).toBe(fs.constants.O_APPEND);
	} finally {
		fs.closeSync(fd);
	}
});
