import { parseHTML } from "../packages/utils/src/dom";
import { Readability } from "../packages/utils/src/readability";
import { formatArtifact, runSuite } from "./harness";

function nestedArticle(containers: number): string {
	const sections = Array.from({ length: containers }, (_, index) => {
		const link = `<a href="/story/${index}">linked ${index}</a>`;
		return `<section class="content"><p>Container ${index} contains enough prose to be scored and ${link}.</p>`;
	}).join("");
	return `<!doctype html><html lang="en"><head><title>Nested content benchmark fixture</title></head><body>${sections}${"</section>".repeat(containers)}</body></html>`;
}

const fixtures = new Map([1_000, 2_000, 4_000].map(count => [count, nestedArticle(count)]));
const artifact = await runSuite(
	"readability",
	[...fixtures.keys()].map(count => ({
		name: `parse-${count}-containers`,
		runs: 1,
		warmup: 0,
		setup: () => fixtures.get(count)!,
		run: (html: string) => {
			const document = parseHTML(html).document;
			return new Readability(document).parse();
		},
	})),
);
process.stdout.write(`${formatArtifact(artifact)}\n`);
