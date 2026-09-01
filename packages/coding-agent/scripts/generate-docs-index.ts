import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { Glob } from "bun";

const packageDir = path.resolve(import.meta.dir, "..");
const docsDir = path.resolve(packageDir, "../../docs");

export interface DocsIndexPayload {
	readonly files: readonly string[];
	readonly bodies: readonly string[];
	readonly payload: string;
}

export async function buildDocsIndexPayload(): Promise<DocsIndexPayload> {
	const glob = new Glob("**/*.md");
	const files: string[] = [];
	for await (const relativePath of glob.scan(docsDir)) {
		files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();

	const bodies = await Promise.all(files.map(file => Bun.file(path.join(docsDir, file)).text()));
	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString("base64");
	return {
		files,
		bodies,
		payload: `${JSON.stringify(files)}\n${bodiesB64}`,
	};
}
