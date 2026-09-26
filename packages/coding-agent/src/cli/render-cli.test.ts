import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { CURRENT_SESSION_VERSION } from "../session/session-entries";
import { sessionArchivePath } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";

test("render prints every message beyond the interactive transcript window without changing the session", async () => {
	await using fixture = await TempDir.create("@proto-render-full-history-");
	const sessionFile = path.join(fixture.path(), "session.jsonl");
	const timestamp = new Date(0).toISOString();
	const markers = Array.from({ length: 300 }, (_, index) => `render-message-${String(index).padStart(4, "0")}`);
	const entries = markers.map((marker, index) => ({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp,
		message: { role: "user", content: marker, timestamp: index },
	}));
	const source = `${[
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "render-full-history",
			cwd: fixture.path(),
			timestamp,
		},
		...entries,
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
	await Bun.write(sessionFile, source);
	const cli = path.resolve(import.meta.dir, "../cli.ts");
	const result = await $`${process.execPath} ${cli} render ${sessionFile} --plain --width 80 --height 8`
		.cwd(fixture.path())
		.env({ ...process.env, PI_CODING_AGENT_DIR: path.join(fixture.path(), "profile") })
		.quiet()
		.nothrow();
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect([...result.text().matchAll(/render-message-\d{4}/g)].map(match => match[0])).toEqual(markers);
	expect(await Bun.file(sessionFile).text()).toBe(source);
}, 30_000);

test("render streams archived and recent pages exactly once without rewriting durable history", async () => {
	await using fixture = await TempDir.create("@proto-render-archive-");
	const manager = SessionManager.create(fixture.path(), fixture.path());
	const markers = Array.from({ length: 300 }, (_, index) => `archive-render-${String(index).padStart(4, "0")}`);
	let kept = "";
	for (const [index, content] of markers.entries()) {
		const id = manager.appendMessage({ role: "user", content, timestamp: index });
		if (index === 280) kept = id;
	}
	manager.appendCompaction("archived-summary", undefined, kept, 5000);
	await manager.ensureOnDisk();
	await manager.flush();
	await manager.archiveCompactedHistory(kept);
	const sessionFile = manager.getSessionFile()!;
	await manager.close();
	const source = await Bun.file(sessionFile).text();
	const archive = await Bun.file(sessionArchivePath(sessionFile)).bytes();
	const cli = path.resolve(import.meta.dir, "../cli.ts");
	const result = await $`${process.execPath} ${cli} render ${sessionFile} --plain --width 80 --height 8`
		.cwd(fixture.path())
		.env({ ...process.env, PI_CODING_AGENT_DIR: path.join(fixture.path(), "profile") })
		.quiet()
		.nothrow();
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	expect([...result.text().matchAll(/archive-render-\d{4}/g)].map(match => match[0])).toEqual(markers);
	expect(await Bun.file(sessionFile).text()).toBe(source);
	expect(await Bun.file(sessionArchivePath(sessionFile)).bytes()).toEqual(archive);
}, 30_000);
