import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";

const { KernelStdio } = createRequire(import.meta.url)(process.env.PROTO_TEST_NATIVE_ADDON);
const mode = process.argv[2];
let capture;

function control(message) {
	process.send(message);
}

function nativeConsole() {
	console.log("native formatter", { nested: { answer: 42 }, missing: undefined }, new Set([1, 2]));
	console.error("native stderr", new Uint8Array([0, 128, 255]));
	console.table([{ name: "é", value: 7 }, { name: "two", value: 8 }]);
}

function writeAll(fd, data) {
	for (let offset = 0; offset < data.length;) offset += fs.writeSync(fd, data, offset);
}

async function main() {
	if (mode === "baseline") {
		nativeConsole();
		return;
	}
	if (mode === "capture") {
		capture = new KernelStdio();
		try { new KernelStdio(); }
		catch (error) { control({ type: "ownership", message: error.message }); }
		capture.start("binary");
		writeAll(1, Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
		writeAll(2, Buffer.from([0, 255, 10, 13, 128]));
		control({ type: "fence", runId: "binary", sequence: capture.finish() });
		capture.start("console");
		nativeConsole();
		control({ type: "fence", runId: "console", sequence: capture.finish() });
		fs.writeSync(1, "idle output must not enter the frame transport");
		fs.writeSync(2, "idle stderr must be discarded");
		capture.close();
		capture.close();
		fs.writeSync(1, '{"type":"restored"}\n');
		fs.writeSync(2, "restored stderr\n");
		return;
	}
	if (mode === "lifetime") {
		capture = new KernelStdio();
		capture.start("first");
		fs.writeSync(1, "first-before\n");
		const child = spawn("/bin/sh", ["-c", "read token; printf child-late; printf child-stderr >&2"], {
			stdio: ["pipe", "inherit", "inherit"],
		});
		const exited = once(child, "close");
		control({ type: "fence", runId: "first", sequence: capture.finish() });
		capture.start("second");
		fs.writeSync(1, "second-before\n");
		capture.start("first");
		fs.writeSync(1, "first-nested\n");
		capture.start("first");
		fs.writeSync(1, "first-same-owner\n");
		capture.finish();
		capture.finish();
		fs.writeSync(1, "second-after\n");
		control({ type: "retained", sequence: capture.write("first", "stderr", Buffer.from("retained-stderr\n")) });
		fs.writeSync(2, "second-stderr\n");
		control({ type: "fence", runId: "second", sequence: capture.finish() });
		// The child now writes after all scopes have ended. Its inherited fds still own "first".
		child.stdin.end("go\n");
		await exited;
		control({ type: "final-fence", sequence: capture.flush() });
		return;
	}
	if (mode === "backpressure") {
		capture = new KernelStdio();
		capture.start("flood");
		control({ type: "writing" });
		const block = Buffer.alloc(64 * 1024, 120);
		for (let index = 0; index < 128; index++) writeAll(1, block);
		control({ type: "written", sequence: capture.finish() });
		return;
	}
	if (mode === "continuous" || mode === "cancel") {
		capture = new KernelStdio();
		capture.start("continuous");
		const child = spawn(process.execPath, ["-e", `
			const fs = require("node:fs");
			const block = Buffer.alloc(64 * 1024, 121);
			for (let offset = 0; offset < block.length;) offset += fs.writeSync(1, block, offset);
			fs.writeSync(3, "ready");
			for (;;) fs.writeSync(1, block);
		`], { stdio: ["ignore", "inherit", "inherit", "pipe"] });
		const exited = once(child, "close");
		try {
			if (mode === "continuous") {
				await once(child.stdio[3], "data");
				control({ type: "live-barrier", sequence: capture.flush(), childAlive: child.exitCode === null });
			} else {
				// The host deliberately stops reading native frames before asking us to close.
				await once(process, "message");
				capture.close();
				control({ type: "cancelled" });
			}
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
		if (mode === "continuous") control({ type: "final-fence", sequence: capture.finish() });
		return;
	}
	if (mode === "cleanup") {
		const before = fs.readdirSync("/dev/fd").length;
		capture = new KernelStdio();
		for (let index = 0; index < 512; index++) {
			capture.start(`short-${index}`);
			fs.writeSync(1, "x");
			capture.finish();
		}
		capture.start("descendant");
		const child = spawn("/bin/sh", ["-c", "read token"], { stdio: ["pipe", "inherit", "inherit"] });
		const exited = once(child, "close");
		capture.close();
		control({ type: "closed-with-live-descendant" });
		child.stdin.end("go\n");
		await exited;
		const after = fs.readdirSync("/dev/fd").length;
		// A new owner must be allowed after scoped teardown, with no leaked original capture.
		capture = new KernelStdio();
		capture.start("replacement");
		fs.writeSync(1, "replacement");
		capture.finish();
		capture.close();
		control({ type: "resources", before, after });
		return;
	}
	throw new Error(`unknown fixture mode ${mode}`);
}

try {
	await main();
} catch (error) {
	capture?.close();
	fs.writeSync(2, `${error.stack}\n`);
	process.exitCode = 1;
} finally {
	capture?.close();
	process.disconnect();
}
