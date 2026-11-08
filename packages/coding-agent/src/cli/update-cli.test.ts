import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getProtofsLibraryName,
	parseReportedVersion,
	resolveUpdateTargetFromPath,
	updateSiblingProtofsLibrary,
	updateViaBinaryAt,
} from "./update-cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-update-cli-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** A release whose only asset is `assetName`; `includeAsset: false` models an older release. */
function releaseFetch(assetName: string, body: Uint8Array, includeAsset = true) {
	const url = `https://github.com/myanvoos/proto/releases/download/v19.9.9/${assetName}`;
	const metadata = {
		tag_name: "v19.9.9",
		draft: false,
		prerelease: false,
		assets: includeAsset
			? [
					{
						name: assetName,
						state: "uploaded",
						size: body.byteLength,
						digest: `sha256:${sha256(body)}`,
						browser_download_url: url,
					},
				]
			: [],
	};
	return vi.fn(async (input: string | URL | Request) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (href.endsWith("/releases/tags/v19.9.9")) return new Response(JSON.stringify(metadata));
		if (href === url) return new Response(body);
		return new Response("missing", { status: 404 });
	});
}

describe("parseReportedVersion", () => {
	it("reads proto's version output, including prerelease suffixes", () => {
		expect(parseReportedVersion("proto/19.1.4")).toBe("19.1.4");
		expect(parseReportedVersion("proto/19.2.0-rc.1")).toBe("19.2.0-rc.1");
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/19.1.4")).toBeUndefined();
		expect(parseReportedVersion("1.4.2")).toBeUndefined();
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});
});

describe("updateViaBinaryAt behind a foreign symlink", () => {
	async function updateThroughAlias(aliasPath: string, fetchImpl: () => Promise<Response>) {
		const target = resolveUpdateTargetFromPath(aliasPath, undefined);
		if (target.method !== "binary") throw new Error("Expected binary update target");
		expect(target.validateExistingTarget).toBe(true);
		return updateViaBinaryAt(target.path, "19.9.9", {
			binaryName: "proto-linux-x64",
			fetchImpl,
			githubToken: "test-token",
			validateExistingTarget: target.validateExistingTarget,
		});
	}

	it("refuses to overwrite a shared shebang dispatcher", async () => {
		const dir = await makeTempDir();
		const dispatcherPath = path.join(dir, "launch");
		const aliasPath = path.join(dir, "proto");
		const dispatcher = "#!/bin/sh\necho proto/19.1.4\n";
		await Bun.write(dispatcherPath, dispatcher);
		await fs.chmod(dispatcherPath, 0o755);
		await fs.symlink("launch", aliasPath);
		const fetchImpl = vi.fn(async () => new Response());
		// Resolve the expected path before the update promise exists: the rejection
		// must be handled in the same turn, or Bun reports it as unhandled.
		const expected = `Refusing to replace ${await fs.realpath(dispatcherPath)}`;

		await expect(updateThroughAlias(aliasPath, fetchImpl)).rejects.toThrow(expected);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await Bun.file(dispatcherPath).text()).toBe(dispatcher);
	});

	it("refuses a native target that does not report a proto version", async () => {
		const dir = await makeTempDir();
		const aliasPath = path.join(dir, "proto");
		await fs.symlink(process.execPath, aliasPath);
		const fetchImpl = vi.fn(async () => new Response());

		await expect(updateThroughAlias(aliasPath, fetchImpl)).rejects.toThrow(
			"does not report a proto version when run directly",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("updateSiblingProtofsLibrary", () => {
	it("replaces the sibling library with the verified release asset", async () => {
		const dir = await makeTempDir();
		const libraryName = getProtofsLibraryName();
		expect(libraryName).toBeDefined();
		if (!libraryName) return;
		const libraryPath = path.join(dir, libraryName);
		await Bun.write(libraryPath, "old library");
		const next = new TextEncoder().encode("new library");
		const fetchImpl = releaseFetch(libraryName, next);

		await updateSiblingProtofsLibrary(path.join(dir, "proto"), "19.9.9", { fetchImpl, githubToken: "test-token" });

		expect(await Bun.file(libraryPath).text()).toBe("new library");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not create a library when the install has none", async () => {
		const dir = await makeTempDir();
		const libraryName = getProtofsLibraryName();
		expect(libraryName).toBeDefined();
		if (!libraryName) return;
		const fetchImpl = releaseFetch(libraryName, new Uint8Array());

		await updateSiblingProtofsLibrary(path.join(dir, "proto"), "19.9.9", { fetchImpl });

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(dir, libraryName)).exists()).toBe(false);
	});

	it("keeps the existing library when the release publishes none", async () => {
		const dir = await makeTempDir();
		const libraryName = getProtofsLibraryName();
		expect(libraryName).toBeDefined();
		if (!libraryName) return;
		const libraryPath = path.join(dir, libraryName);
		await Bun.write(libraryPath, "old library");
		const fetchImpl = releaseFetch(libraryName, new Uint8Array(), false);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await updateSiblingProtofsLibrary(path.join(dir, "proto"), "19.9.9", { fetchImpl });

		expect(await Bun.file(libraryPath).text()).toBe("old library");
		expect(log.mock.calls.flat().join("\n")).toContain("protofs library not updated");
	});
});
