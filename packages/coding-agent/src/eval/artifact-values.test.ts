import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { ArtifactManager } from "../session/artifacts";
import type { ToolSession } from "../tools";
import {
	disposeEvalArtifacts,
	MAX_EVAL_ARTIFACT_BYTES,
	MAX_EVAL_ARTIFACT_READ_BYTES,
	publishEvalArtifact,
	readEvalArtifact,
	resolveEvalArtifact,
	runEvalArtifact,
} from "./artifact-values";

function sessionAt(cwd: string): ToolSession {
	const manager = new ArtifactManager(path.join(cwd, "artifacts"));
	return {
		cwd,
		getArtifactManager: () => manager,
		getArtifactsDir: () => manager.dir,
		allocateOutputArtifact: type => manager.allocatePath(type),
		localProtocolOptions: { getArtifactsDir: () => manager.dir },
	} as ToolSession;
}

test("published JSON and byte values are snapshots, and republishing allocates a new immutable version", async () => {
	using tmp = TempDir.createSync("@artifact-values-");
	const session = sessionAt(tmp.path());
	const source = { rows: [1, 2] };
	const original = await publishEvalArtifact({ kind: "json", value: source }, { session });
	source.rows.push(3);
	const next = await publishEvalArtifact({ kind: "json", value: source }, { session });
	expect(next.uri).not.toBe(original.uri);
	expect(next.sha256).not.toBe(original.sha256);
	expect((await readEvalArtifact({ ref: original, encoding: "json" }, { session })).data).toEqual({ rows: [1, 2] });
	const bytes = new Uint8Array([0, 1, 255]);
	const binary = await publishEvalArtifact({ kind: "binary", value: bytes }, { session });
	bytes.fill(44);
	const first = await resolveEvalArtifact(binary, { session });
	first.data.fill(99);
	expect(Array.from((await resolveEvalArtifact(binary, { session })).data)).toEqual([0, 1, 255]);
	expect(binary.bytes).toBe(3);
	expect(binary.sha256).toBe(new Bun.CryptoHasher("sha256").update(new Uint8Array([0, 1, 255])).digest("hex"));
	expect(() => Object.assign(binary, { bytes: 20 })).toThrow();
});

test("file publication copies exact bytes into the shared artifact allocator, independent of source edits", async () => {
	using tmp = TempDir.createSync("@artifact-file-");
	const session = sessionAt(tmp.path());
	const manager = session.getArtifactManager!()!;
	await manager.save("shell output", "bash");
	await Bun.write(path.join(tmp.path(), "source.dat"), new Uint8Array([255, 0, 80, 78, 71]));
	const ref = await publishEvalArtifact({ kind: "binary", path: "source.dat", mimeType: "image/png" }, { session });
	await Bun.write(path.join(tmp.path(), "source.dat"), "changed source");
	expect(ref.uri).toBe("artifact://1");
	const stored = await manager.getPath("1");
	expect(stored).toEndWith("1.kernel-artifact.log");
	expect(Array.from((await resolveEvalArtifact(ref, { session })).data)).toEqual([255, 0, 80, 78, 71]);
	expect((await fs.stat(stored!)).mode & 0o222).toBe(0);
	const copied = await publishEvalArtifact({ kind: "binary", path: ref.uri, mimeType: ref.mimeType }, { session });
	expect(copied.uri).not.toBe(ref.uri);
	expect(copied.sha256).toBe(ref.sha256);
});

test("bounded reads expose exact page boundaries and reject partial JSON", async () => {
	using tmp = TempDir.createSync("@artifact-reads-");
	const session = sessionAt(tmp.path());
	const ref = await publishEvalArtifact({ kind: "text", value: "aéz" }, { session });
	expect(await readEvalArtifact({ ref, offset: 1, length: 2, encoding: "base64" }, { session })).toMatchObject({
		offset: 1,
		bytes: 2,
		eof: false,
		encoding: "base64",
		data: "w6k=",
	});
	expect(await readEvalArtifact({ ref, offset: 3, length: 8 }, { session })).toMatchObject({
		offset: 3,
		bytes: 1,
		eof: true,
		encoding: "utf8",
		data: "z",
	});
	await expect(readEvalArtifact({ ref, length: MAX_EVAL_ARTIFACT_READ_BYTES + 1 }, { session })).rejects.toThrow(
		"length",
	);
	await expect(readEvalArtifact({ ref, offset: 5 }, { session })).rejects.toThrow("exceeds its size");
	const json = await publishEvalArtifact({ kind: "json", value: [10, 20] }, { session });
	await expect(readEvalArtifact({ ref: json, length: 2, encoding: "json" }, { session })).rejects.toThrow(
		"entire artifact",
	);
});

test("default UTF-8 paging ends pages on character boundaries and rejects binary bytes", async () => {
	using tmp = TempDir.createSync("@artifact-utf8-");
	const session = sessionAt(tmp.path());
	// "a" (1 byte) + "é" (2 bytes) + "😀" (4 bytes) + "z": limits split both multi-byte characters.
	const ref = await publishEvalArtifact({ kind: "text", value: "aé😀z" }, { session });
	const pages: string[] = [];
	for (let offset = 0, eof = false; !eof; ) {
		const page = await readEvalArtifact({ ref, offset, length: 4 }, { session });
		pages.push(page.data as string);
		offset += page.bytes;
		eof = page.eof;
	}
	expect(pages).toEqual(["aé", "😀", "z"]);
	await expect(readEvalArtifact({ ref, offset: 2 }, { session })).rejects.toThrow("inside a UTF-8 character");
	await expect(readEvalArtifact({ ref, offset: 3, length: 3 }, { session })).rejects.toThrow("cannot hold");
	const binary = await publishEvalArtifact({ kind: "binary", value: new Uint8Array([0x61, 0xff, 0x62]) }, { session });
	await expect(readEvalArtifact({ ref: binary }, { session })).rejects.toThrow('encoding="base64"');
	expect((await readEvalArtifact({ ref: binary, encoding: "base64" }, { session })).data).toBe("Yf9i");
});

test("a bare artifact:// URI reads and resolves only artifacts this session published", async () => {
	using tmp = TempDir.createSync("@artifact-uri-");
	const session = sessionAt(tmp.path());
	const manager = session.getArtifactManager!()!;
	const ref = await publishEvalArtifact({ kind: "text", value: "by uri" }, { session });
	expect((await readEvalArtifact({ ref: ref.uri }, { session })).data).toBe("by uri");
	expect(await runEvalArtifact({ op: "artifact_resolve", ref: ref.uri }, { session })).toEqual(ref);
	const { id } = await manager.allocatePath("bash");
	await expect(readEvalArtifact({ ref: `artifact://${id}` }, { session })).rejects.toThrow(
		"not published by this kernel session",
	);
	await expect(readEvalArtifact({ ref: `${ref.uri}:1-2` }, { session })).rejects.toThrow("Invalid artifact reference");
});

test("same-length tampering, changed size, and forged metadata cannot resolve as an immutable handle", async () => {
	using tmp = TempDir.createSync("@artifact-integrity-");
	const session = sessionAt(tmp.path());
	const ref = await publishEvalArtifact({ kind: "text", value: "abc" }, { session });
	await expect(resolveEvalArtifact({ ...ref, bytes: 4 }, { session })).rejects.toThrow("metadata");
	await expect(resolveEvalArtifact({ ...ref, mimeType: "image/png" }, { session })).rejects.toThrow("metadata");
	const file = (await session.getArtifactManager!()!.getPath(ref.uri.slice("artifact://".length)))!;
	await fs.chmod(file, 0o600);
	await Bun.write(file, "xyz");
	await expect(resolveEvalArtifact(ref, { session })).rejects.toThrow("integrity");
	await Bun.write(file, "abcd");
	await expect(resolveEvalArtifact(ref, { session })).rejects.toThrow("integrity");
});

test("session ownership prevents colliding artifact IDs, symlink escapes, and use after disposal", async () => {
	using tmp = TempDir.createSync("@artifact-owner-");
	const a = sessionAt(path.join(tmp.path(), "a"));
	const b = sessionAt(path.join(tmp.path(), "b"));
	const refA = await publishEvalArtifact({ kind: "text", value: "owner a" }, { session: a });
	const refB = await publishEvalArtifact({ kind: "text", value: "owner b" }, { session: b });
	expect(refA.uri).toBe(refB.uri);
	await expect(resolveEvalArtifact(refA, { session: b })).rejects.toThrow("another session");
	await expect(publishEvalArtifact({ kind: "binary", path: "artifact://99" }, { session: b })).rejects.toThrow(
		"does not belong",
	);
	const fileA = (await a.getArtifactManager!()!.getPath("0"))!;
	const fileB = (await b.getArtifactManager!()!.getPath("0"))!;
	await fs.rm(fileA);
	await fs.symlink(fileB, fileA);
	await expect(resolveEvalArtifact(refA, { session: a })).rejects.toThrow("outside session storage");
	disposeEvalArtifacts(b);
	await expect(resolveEvalArtifact(refB, { session: b })).rejects.toThrow("disposed");
});

test("snapshot JSON can round-trip handles while a changed session identity invalidates them", async () => {
	using tmp = TempDir.createSync("@artifact-roundtrip-");
	const session = sessionAt(tmp.path());
	let id = "first";
	session.getSessionId = () => id;
	const ref = await publishEvalArtifact({ kind: "text", value: "same session" }, { session });
	const restored = JSON.parse(JSON.stringify(ref));
	expect((await readEvalArtifact({ ref: restored, encoding: "utf8" }, { session })).data).toBe("same session");
	id = "second";
	await expect(resolveEvalArtifact(restored, { session })).rejects.toThrow("another session");
});

test("publication rejects oversized, ambiguous, malformed base64, and lossy JSON values before allocating", async () => {
	using tmp = TempDir.createSync("@artifact-invalid-");
	const session = sessionAt(tmp.path());
	let getterCalls = 0;
	const accessor = {
		get secret() {
			getterCalls++;
			return "no";
		},
	};
	const cycle: { next?: unknown } = {};
	cycle.next = cycle;
	await expect(publishEvalArtifact({ kind: "json", value: accessor }, { session })).rejects.toThrow("accessors");
	await expect(publishEvalArtifact({ kind: "json", value: cycle }, { session })).rejects.toThrow("acyclic");
	await expect(publishEvalArtifact({ kind: "json", value: { missing: undefined } }, { session })).rejects.toThrow(
		"lossless JSON",
	);
	await expect(
		publishEvalArtifact({ kind: "json", value: Object.assign(new Array(1), { extra: 1 }) }, { session }),
	).rejects.toThrow("sparse");
	await expect(
		publishEvalArtifact({ kind: "binary", value: "AQ==\n", encoding: "base64" }, { session }),
	).rejects.toThrow("canonical base64");
	await expect(
		publishEvalArtifact({ kind: "binary", value: new Uint8Array(MAX_EVAL_ARTIFACT_BYTES + 1) }, { session }),
	).rejects.toThrow("byte limit");
	const repeated = "x".repeat(MAX_EVAL_ARTIFACT_BYTES / 2);
	await expect(publishEvalArtifact({ kind: "json", value: [repeated, repeated] }, { session })).rejects.toThrow(
		"byte limit",
	);
	await expect(publishEvalArtifact({ kind: "text", value: "v", path: "p" }, { session })).rejects.toThrow(
		"exactly one",
	);
	await expect(
		runEvalArtifact({ op: "artifact_publish", kind: "text", value: "ok", replace: true }, { session }),
	).rejects.toThrow("Unknown artifact argument");
	await expect(
		publishEvalArtifact(
			{ kind: "text", value: "cancelled" },
			{ session, signal: AbortSignal.abort(new Error("cancelled")) },
		),
	).rejects.toThrow("cancelled");
	expect(getterCalls).toBe(0);
	expect(await session.getArtifactManager!()!.listFiles()).toEqual([]);
});

test("internal URL publication reads original binary bytes and UTF-8 preserves a leading BOM", async () => {
	using tmp = TempDir.createSync("@artifact-local-url-");
	const session = sessionAt(tmp.path());
	const file = resolveLocalUrlToPath("local://source.bin", session.localProtocolOptions!);
	await Bun.write(file, new Uint8Array([0, 255, 10]));
	const binary = await publishEvalArtifact({ kind: "binary", path: "local://source.bin" }, { session });
	expect(Array.from((await resolveEvalArtifact(binary, { session })).data)).toEqual([0, 255, 10]);
	const text = await publishEvalArtifact({ kind: "text", value: "\ufeffprefix" }, { session });
	expect((await readEvalArtifact({ ref: text, encoding: "utf8" }, { session })).data).toBe("\ufeffprefix");
});
