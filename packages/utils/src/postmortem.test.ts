import { expect, test } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { TempDir } from "./temp";

test("quit drains large piped stdout before exiting successfully", async () => {
	await using fixture = await TempDir.create("@proto-stdout-drain-");
	const source = path.join(import.meta.dir, "postmortem.ts");
	const script = fixture.join("writer.ts");
	await Bun.write(
		script,
		`
import { quit } from ${JSON.stringify(source)};
process.stdout.write("界x".repeat(2 * 1024 * 1024));
await quit(0);
`,
	);
	const result = await $`${process.execPath} ${script}`.quiet().nothrow();
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect(result.stdout.byteLength).toBe(8 * 1024 * 1024);
	expect(result.text()).toBe("界x".repeat(2 * 1024 * 1024));
}, 15_000);

async function runPostmortemScript(body: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	await using fixture = await TempDir.create("@proto-postmortem-");
	const script = fixture.join("probe.ts");
	const source = JSON.stringify(path.join(import.meta.dir, "postmortem.ts"));
	await Bun.write(
		script,
		// The side-effect import installs the process handlers even when the body never names `postmortem`.
		`import ${source};\nimport * as postmortem from ${source};\n${body}`,
	);
	const result = await $`${process.execPath} ${script}`.quiet().nothrow();
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("cleanup() awaits an async callback registered while its pass runs", async () => {
	const result = await runPostmortemScript(`
const order = [];
postmortem.register("outer", () => {
	postmortem.register("late", async () => {
		const { promise, resolve } = Promise.withResolvers();
		setImmediate(resolve);
		await promise;
		order.push("late");
	});
	order.push("outer");
});
await postmortem.cleanup();
order.push("settled");
console.log(JSON.stringify(order));
`);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain('["outer","late","settled"]');
}, 15_000);

test("a SIGTERM exit finishes async cleanup registered during the exit pass", async () => {
	const result = await runPostmortemScript(`
postmortem.register("outer", () => {
	postmortem.register("late", async () => {
		const { promise, resolve } = Promise.withResolvers();
		setImmediate(resolve);
		await promise;
		console.log("late-done");
	});
});
process.kill(process.pid, "SIGTERM");
await Promise.withResolvers().promise;
`);
	expect(result.exitCode).toBe(143);
	expect(result.stdout).toContain("late-done");
}, 15_000);

test("a registration runs at a keep-alive cleanup and again at the real exit", async () => {
	const result = await runPostmortemScript(`
postmortem.register("owner", reason => {
	console.log("ran:" + reason);
});
await postmortem.cleanup();
process.exit(0);
`);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("ran:manual");
	expect(result.stdout).toContain("ran:exit");
}, 15_000);

test("a write EPIPE that never touched stdout stays fatal while stdout disconnects are handled", async () => {
	const result = await runPostmortemScript(`
postmortem.registerStdioDisconnectHandling();
void Promise.reject(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write" }));
await Promise.withResolvers().promise;
`);
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("[Unhandled Rejection] Error: EPIPE");
}, 15_000);

test.skipIf(process.platform === "win32")(
	"a closed stdout consumer runs cleanup and exits 0 when disconnects are handled",
	async () => {
		await using fixture = await TempDir.create("@proto-postmortem-stdout-");
		const script = fixture.join("writer.ts");
		const marker = fixture.join("cleanup");
		await Bun.write(
			script,
			`import * as postmortem from ${JSON.stringify(path.join(import.meta.dir, "postmortem.ts"))};
postmortem.registerStdioDisconnectHandling();
postmortem.register("marker", async () => {
	await Bun.write(${JSON.stringify(marker)}, "cleanup complete");
});
for (let i = 0; i < 64; i++) process.stdout.write("x".repeat(64 * 1024) + "\\n");
await Promise.withResolvers().promise;
`,
		);
		const result =
			await $`bash -c ${`"${process.execPath}" "${script}" 2>"${fixture.join("err")}" | true; echo "\${PIPESTATUS[0]}"`}`
				.quiet()
				.nothrow();
		const stderr = await Bun.file(fixture.join("err")).text();
		expect(result.text().trim(), stderr).toBe("0");
		expect(stderr).not.toContain("Unhandled Rejection");
		expect(stderr).not.toContain("Uncaught Exception");
		expect(await Bun.file(marker).text()).toBe("cleanup complete");
	},
	15_000,
);

test("a non-EPIPE stdout error is left to the terminal owner instead of exiting", async () => {
	const result = await runPostmortemScript(`
postmortem.registerStdioDisconnectHandling();
process.stdout.emit("error", Object.assign(new Error("EIO"), { code: "EIO", syscall: "write" }));
await Bun.sleep(50);
console.log("survived");
`);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toBe("survived\n");
}, 15_000);

test("an uncaught worker IPC send EPIPE is contained", async () => {
	const result = await runPostmortemScript(`
setImmediate(() => {
	throw Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "send" });
});
await Bun.sleep(200);
console.log("survived");
`);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toBe("survived\n");
	expect(result.stderr).toBe("");
}, 15_000);

test("an uncaught primitive keeps its value in the fatal report", async () => {
	const result = await runPostmortemScript(`
setImmediate(() => {
	throw "unrelated fatal exception";
});
await Promise.withResolvers().promise;
`);
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("[Uncaught Exception] Error: unrelated fatal exception");
}, 15_000);

test("only a frameless node:net ERR_SOCKET_CLOSED is survivable", async () => {
	const result = await runPostmortemScript(`
const socketClosed = stack => Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED", stack });
const netStack = "Error: Socket is closed\\n    at unknown\\n    at close (node:net:686:67)";
console.log(JSON.stringify([
	postmortem.isInternalSocketClosedError(socketClosed(netStack)),
	postmortem.isInternalSocketClosedError(socketClosed("Error: Socket is closed\\n    at send (/app/src/broker.ts:12:3)\\n    at close (node:net:686:67)")),
	postmortem.isInternalSocketClosedError(socketClosed("Error: Socket is closed\\n    at unknown")),
	postmortem.isInternalSocketClosedError(socketClosed("Error: Socket is closed\\n    at tick (node:timers:1:1)")),
	postmortem.isInternalSocketClosedError(Object.assign(new Error("Socket is closed"), { code: "EPIPE", stack: netStack })),
	postmortem.isInternalSocketClosedError("not an error"),
]));
process.emit("uncaughtException", socketClosed(netStack));
await Bun.sleep(50);
console.log("survived");
`);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toBe("[true,false,false,false,false,false]\nsurvived\n");
}, 15_000);

test("exitProcess terminates through a nested guard chain of throwing exit stubs", async () => {
	const result = await runPostmortemScript(`
const stub = message => () => {
	throw new Error(message);
};
const inner = stub("inner reallyExit stub");
Reflect.set(inner, postmortem.NATIVE_PROCESS_EXIT, process.reallyExit);
const outer = stub("outer reallyExit stub");
Reflect.set(outer, postmortem.NATIVE_PROCESS_EXIT, inner);
process.reallyExit = outer;
const innerExit = stub("inner exit stub");
Reflect.set(innerExit, postmortem.NATIVE_PROCESS_EXIT, process.exit);
const outerExit = stub("outer exit stub");
Reflect.set(outerExit, postmortem.NATIVE_PROCESS_EXIT, innerExit);
process.exit = outerExit;
try {
	postmortem.exitProcess(130);
} catch (err) {
	console.error("threw:", err.message);
}
console.error("reached-end");
`);
	expect(result.exitCode).toBe(130);
	expect(result.stderr).toBe("");
}, 15_000);
