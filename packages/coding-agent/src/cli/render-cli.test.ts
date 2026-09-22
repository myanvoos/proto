import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { CURRENT_SESSION_VERSION } from "../session/session-entries";

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
