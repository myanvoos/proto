import { compareArtifacts, loadArtifact } from "./harness";

const [suite, beforeLabel, afterLabel] = Bun.argv.slice(2);
if (!suite || !beforeLabel || !afterLabel) {
	process.stderr.write("usage: bun bench/compare.ts <suite> <before-label> <after-label>\n");
	process.exit(2);
}

const before = await loadArtifact(suite, beforeLabel);
const after = await loadArtifact(suite, afterLabel);
if (!before) {
	process.stderr.write(`missing artifact: ${suite}.${beforeLabel}\n`);
	process.exit(2);
}
if (!after) {
	process.stderr.write(`missing artifact: ${suite}.${afterLabel}\n`);
	process.exit(2);
}

process.stdout.write(`${suite}: ${before.commit} [${beforeLabel}] -> ${after.commit} [${afterLabel}]\n`);
compareArtifacts(before, after);
