import { expect, test } from "bun:test";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../../slash-commands/builtin-registry";
import { buildHelpMarkdown } from "./help-markdown";

test("help panel lists every builtin command with its aliases in registry order", () => {
	const markdown = buildHelpMarkdown({ commands: BUILTIN_SLASH_COMMAND_DEFS });
	const listed = [...markdown.matchAll(/^\| `\/([^`]+)` \|/gm)].map(match => match[1]);

	expect(listed).toEqual(BUILTIN_SLASH_COMMAND_DEFS.map(command => command.name));
	for (const command of BUILTIN_SLASH_COMMAND_DEFS) {
		for (const alias of command.aliases ?? []) {
			expect(markdown).toContain(`| \`/${command.name}\` | \`/${alias}\``);
		}
	}
});

test("help panel escapes table-breaking description characters", () => {
	const markdown = buildHelpMarkdown({
		commands: [{ name: "pipe", description: "left | right\nsecond line" }],
	});
	expect(markdown).toContain("| `/pipe` |  | left \\| right second line |");
});
