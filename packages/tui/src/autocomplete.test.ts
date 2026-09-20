import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider, type SlashCommand } from "./autocomplete";

const COMMANDS: SlashCommand[] = [
	{ name: "clear", description: "Clear the conversation context in place, keeping the session" },
	{ name: "model", aliases: ["models"], description: "Switch model for this session" },
	{ name: "help", aliases: ["?"], description: "Show commands, shortcuts and where to look next" },
	{ name: "quit", aliases: ["q"], description: "Quit the application" },
];

function suggestionsFor(text: string, commands: SlashCommand[] = COMMANDS) {
	const provider = new CombinedAutocompleteProvider(commands, "/tmp");
	const sync = provider.trySyncSlashCompletion(text);
	if (!sync) throw new Error(`no slash completions for ${text}`);
	return sync.items;
}

test("a description-only hit is flagged weak and never outranks a name match", () => {
	// "h-e-l-p" is a subsequence of clear's description; only `help` matches by name.
	const items = suggestionsFor("/help");
	const clear = items.find(item => item.value === "clear");
	expect(clear?.weakMatch).toBe(true);
	expect(items[0]).toMatchObject({ value: "help" });
	expect(items[0]?.weakMatch).toBeUndefined();

	// With no command named `help` registered, the description hit is still offered
	// for discovery but stays weak so a plain Enter cannot accept it.
	const withoutHelp = suggestionsFor(
		"/help",
		COMMANDS.filter(command => command.name !== "help"),
	);
	expect(withoutHelp.map(item => item.value)).toContain("clear");
	expect(withoutHelp.every(item => item.weakMatch === true)).toBe(true);
});

test("name and alias matches are strong regardless of score", () => {
	const model = suggestionsFor("/mod");
	expect(model[0]).toMatchObject({ value: "model" });
	expect(model[0]?.weakMatch).toBeUndefined();

	// "q" fuzzy-matches "quit" by name but the alias `q` is an exact hit.
	const quit = suggestionsFor("/q");
	expect(quit[0]).toMatchObject({ value: "q" });
	expect(quit[0]?.weakMatch).toBeUndefined();
});

test("weak matches sort after every strong match even when their raw score is higher", () => {
	// "cl" is a gapped fuzzy hit on the name `xcxl` (score 35) but a prefix of
	// zzz's description (score 40): raw scores would put the weak match first.
	const commands: SlashCommand[] = [
		{ name: "xcxl", description: "no match here" },
		{ name: "zzz", description: "cl exactly starts this description" },
	];
	const items = suggestionsFor("/cl", commands);
	expect(items.map(item => item.value)).toEqual(["xcxl", "zzz"]);
	expect(items[0]?.weakMatch).toBeUndefined();
	expect(items[1]?.weakMatch).toBe(true);
});
