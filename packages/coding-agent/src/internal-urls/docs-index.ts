import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import { Glob } from "bun";

const docsEmbed = process.env.PI_DOCS_EMBED ?? "";

const gunzipAsync = promisify(gunzip);

interface DocsIndex {
	readonly filenames: readonly string[];
	readonly directory?: string;

	getBody(relativePath: string): Promise<string | undefined>;
}

export function decodeDocsIndex(embed: string): DocsIndex | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;
	const filenames = JSON.parse(embed.slice(0, newline)) as string[];
	let bodies: Promise<Record<string, string>> | undefined;
	return {
		filenames,
		getBody(relativePath: string): Promise<string | undefined> {
			bodies ??= (async () => {
				const inflated = await gunzipAsync(Buffer.from(embed.slice(newline + 1), "base64"));
				const decoded = JSON.parse(inflated.toString("utf8")) as string[];
				const map: Record<string, string> = {};
				for (let i = 0; i < filenames.length; i++) map[filenames[i]] = decoded[i];
				return map;
			})();
			return bodies.then(map => map[relativePath]);
		},
	};
}

function readDocsFromDisk(): DocsIndex | null {
	const docsDir = path.resolve(import.meta.dir, "../../../../docs");
	const filenames: string[] = [];
	try {
		for (const relativePath of new Glob("**/*.md").scanSync(docsDir)) {
			const normalized = relativePath.split(path.sep).join("/");
			filenames.push(normalized);
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	filenames.sort();
	if (filenames.length === 0) return null;
	return {
		filenames,
		directory: docsDir,
		getBody: relativePath =>
			filenames.includes(relativePath)
				? Bun.file(path.join(docsDir, relativePath)).text()
				: Promise.resolve(undefined),
	};
}

function readShippedEmbed(): DocsIndex | null {
	const embedPath = path.resolve(import.meta.dir, "../../dist/docs-index.generated.txt");
	let raw: string;
	try {
		raw = readFileSync(embedPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	const decoded = decodeDocsIndex(raw);
	if (decoded === null) {
		throw new Error(
			`Malformed shipped docs index at ${embedPath}: payload without a newline separator. Rebuild the bundle.`,
		);
	}
	return decoded;
}

function emptyIndex(): DocsIndex {
	logger.warn(
		"harness:// docs corpus unavailable: no build-time embed, on-disk docs/ directory, or shipped dist embed found",
	);
	return { filenames: [], getBody: () => Promise.resolve(undefined) };
}

let index: DocsIndex | undefined;
function getIndex(): DocsIndex {
	if (index !== undefined) return index;

	if (docsEmbed.length > 0) {
		const decoded = decodeDocsIndex(docsEmbed);
		if (decoded === null) {
			throw new Error(
				"Malformed embedded docs index: non-empty payload without a newline separator. " +
					"Rebuild the binary or bundle.",
			);
		}
		index = decoded;
		return index;
	}

	index = readDocsFromDisk() ?? readShippedEmbed() ?? emptyIndex();
	return index;
}

export function getDocFilenames(): readonly string[] {
	return getIndex().filenames;
}

export function getEmbeddedDoc(relativePath: string): Promise<string | undefined> {
	return getIndex().getBody(relativePath);
}

// Publish complete directories atomically so concurrent processes never see a partial corpus.
const materializedDirectories = new Map<string, Promise<string>>();
export function getBundledResourceDirectory(
	name: "harness" | "rules",
	load: () => Promise<ReadonlyArray<readonly [string, string]>>,
): Promise<string> {
	const cacheRoot = path.join(getConfigRootDir(), "cache", "docs");
	const cacheKey = path.join(cacheRoot, name);
	const cached = materializedDirectories.get(cacheKey);
	if (cached) return cached;
	const pending = (async () => {
		const entries = await load();
		const buildKey = `${VERSION}-${Bun.hash(JSON.stringify(entries)).toString(16)}`;
		const directory = path.join(cacheRoot, buildKey, name);
		try {
			await fs.access(directory);
			return directory;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await fs.mkdir(path.dirname(directory), { recursive: true });
		const staging = await fs.mkdtemp(`${directory}-`);
		try {
			for (const [filename, content] of entries) {
				const target = path.join(staging, filename);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, content, { mode: 0o444 });
			}
			try {
				await fs.rename(staging, directory);
			} catch (error) {
				// Another process may have published the same build while we unpacked.
				if (!error || typeof error !== "object" || !("code" in error)) throw error;
				if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
			}
			return directory;
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	})();
	materializedDirectories.set(cacheKey, pending);
	void pending.catch(() => materializedDirectories.delete(cacheKey));
	return pending;
}

export function getDocsDirectory(): Promise<string> {
	const directory = getIndex().directory;
	if (directory) return Promise.resolve(directory);
	return getBundledResourceDirectory("harness", () =>
		Promise.all(
			getDocFilenames().map(async filename => {
				const content = await getEmbeddedDoc(filename);
				if (content === undefined) throw new Error(`Missing bundled documentation: ${filename}`);
				return [filename, content] as const;
			}),
		),
	);
}
