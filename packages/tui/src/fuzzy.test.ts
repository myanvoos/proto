import { expect, test } from "bun:test";
import { FuzzyCorpus, FuzzyQuery, FuzzyText, fuzzyMatch, fuzzyRank } from "./fuzzy";

test("prepared searches retain token, acronym and alphanumeric transposition matching", () => {
	const items = ["GPT 5 Codex", "GPT 4", "Claude Sonnet", "OpenAI GPT 5"];
	const corpus = new FuzzyCorpus(items, value => value);
	for (const query of ["gpt codex", "5gpt", "cs", "!!!", "missing"]) {
		const prepared = new FuzzyQuery(query);
		expect(corpus.rank(query)).toEqual(fuzzyRank(items, query, value => value));
		for (const text of items) {
			expect(prepared.match(new FuzzyText(text))).toEqual(fuzzyMatch(query, text));
			expect(new FuzzyText(text).match(prepared)).toEqual(fuzzyMatch(query, text));
		}
	}
	expect(corpus.rank("gpt codex").map(result => result.item)).toEqual(["GPT 5 Codex"]);
	expect(corpus.rank("missing")).toEqual([]);
});
