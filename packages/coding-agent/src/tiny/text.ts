import { cleanTinyMessage, isPreformattedChatContext, stripChatScaffolding } from "./message-preproc";

const FILLER_TITLE_TOKENS = new Set<string>([
	"hi",
	"hii",
	"hiii",
	"hiya",
	"hey",
	"heya",
	"hello",
	"helo",
	"hullo",
	"yo",
	"ya",
	"sup",
	"wassup",
	"whatsup",
	"howdy",
	"greetings",
	"hola",
	"ciao",
	"aloha",
	"gm",
	"gn",
	"good",
	"morning",
	"afternoon",
	"evening",
	"night",
	"day",

	"thanks",
	"thank",
	"thx",
	"ty",
	"tysm",
	"cheers",
	"please",
	"pls",
	"plz",
	"ok",
	"okay",
	"okey",
	"k",
	"kk",
	"yep",
	"yes",
	"yeah",
	"yup",
	"nope",
	"no",
	"nah",
	"sure",
	"cool",
	"nice",
	"great",
	"awesome",
	"perfect",
	"lol",
	"lmao",
	"haha",
	"hehe",

	"test",
	"tests",
	"testing",
	"ping",
	"pong",
	"there",
	"you",
	"u",
	"hmm",
	"hmmm",
	"um",
	"uh",
	"so",
	"well",
	"anyway",
]);

const TITLE_WORD = /[\p{L}\p{N}]+/gu;
const COMMON_TITLE_ACRONYMS = new Set<string>([
	"API",
	"CLI",
	"CPU",
	"CRUD",
	"CSS",
	"DNS",
	"ETL",
	"GPU",
	"HTML",
	"HTTP",
	"HTTPS",
	"ID",
	"JSON",
	"LLM",
	"REST",
	"SDK",
	"SSH",
	"TCP",
	"TLS",
	"TUI",
	"UI",
	"URI",
	"URL",
	"UX",
	"XML",
	"YAML",
]);

export function isLowSignalTitleInput(message: string): boolean {
	const cleaned = isPreformattedChatContext(message) ? stripChatScaffolding(message) : cleanTinyMessage(message);
	const tokens = cleaned.toLowerCase().match(TITLE_WORD);
	if (!tokens) return true;
	return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

export const NO_TITLE_SENTINEL = "none";

const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;

// Models routinely answer a title prompt with a markdown heading, a bullet or a
// bolded phrase. The markers are formatting, not part of the name, and a title
// is rendered as plain text everywhere it appears (status line, splash resume
// hint, session picker) and stored verbatim in the session record — so they are
// stripped once, here, before the title is ever handed out.
//
// Every pattern demands the structural whitespace or pairing that markdown
// itself demands, so names that merely contain these characters survive:
// "C# refactor", "Fix #123", "1.5 release notes", "snake_case_name",
// "2**8 bytes" and "a * b * c" all pass through untouched.
const TITLE_BLOCK_MARKER_RE = /^(?:>|#{1,6}|[-*+]|\d{1,9}[.)])\s+/;
const TITLE_ATX_CLOSING_RE = /\s+#+$/;
const TITLE_IMAGE_OR_LINK_RE = /!?\[([^\]]*)\]\((?:[^()]*)\)/g;
const TITLE_REFERENCE_LINK_RE = /!?\[([^\]]*)\]\[[^\]]*\]/g;
const TITLE_AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/gi;
const TITLE_CODE_SPAN_RE = /`+([^`]+)`+/g;
const TITLE_STRIKETHROUGH_RE = /~~([^~]+)~~/g;
const TITLE_STRONG_EMPHASIS_RE = /\*{1,3}([^*\s](?:[^*]*[^*\s])?)\*{1,3}/g;
// Underscore emphasis never applies intra-word in CommonMark, so both
// delimiters must sit on a word boundary.
const TITLE_UNDERSCORE_EMPHASIS_RE = /(^|[\s([{])_{1,2}([^_\s](?:[^_]*[^_\s])?)_{1,2}(?=$|[\s)\]}.,;:!?])/g;
const TITLE_ESCAPED_PUNCTUATION_RE = /\\([\\`*_{}[\]()#+\-.!~>|])/g;

/** Reduce a generated title to plain text by removing markdown markup. */
export function stripTitleMarkdown(value: string): string {
	let title = value.trim();
	// Markers nest: "> - **Fix the parser**" needs every leading block marker gone.
	while (TITLE_BLOCK_MARKER_RE.test(title)) {
		const stripped = title.replace(TITLE_BLOCK_MARKER_RE, "").trim();
		if (stripped === title) break;
		title = stripped;
	}
	title = title.replace(TITLE_ATX_CLOSING_RE, "");
	// Links before inline styling so "[**label**](url)" keeps only "label".
	title = title.replace(TITLE_IMAGE_OR_LINK_RE, "$1").replace(TITLE_REFERENCE_LINK_RE, "$1");
	title = title.replace(TITLE_AUTOLINK_RE, "$1");
	title = title.replace(TITLE_CODE_SPAN_RE, "$1");
	title = title.replace(TITLE_STRIKETHROUGH_RE, "$1");
	title = title.replace(TITLE_STRONG_EMPHASIS_RE, "$1");
	title = title.replace(TITLE_UNDERSCORE_EMPHASIS_RE, "$1$2");
	// Last: an escaped marker is literal text and must not be re-read as markup.
	title = title.replace(TITLE_ESCAPED_PUNCTUATION_RE, "$1");
	return title.replace(/\s+/g, " ").trim();
}

export function normalizeGeneratedTitle(value: string | null | undefined, sourceText?: string): string | null {
	const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const unquoted = firstLine.replace(/^["']|["']$/g, "").trim();
	if (/^<title\s*\/>$/i.test(unquoted)) return null;
	const withoutTags = unquoted.replace(/^<title>/i, "").replace(/<\/title>$/i, "");
	const title = stripTitleMarkdown(withoutTags)
		.replace(/^["']|["']$/g, "")
		.replace(/[.!?]$/, "")
		.trim();
	if (!title || title.toLowerCase() === NO_TITLE_SENTINEL) return null;

	const words = title.match(TITLE_WORD)?.length ?? 0;
	if (words === 0 || title.length > MAX_TITLE_CHARS || words > MAX_TITLE_WORDS) return null;
	return sourceText === undefined ? title : reconcileTitleCasing(title, sourceText);
}

function reconcileTitleCasing(title: string, sourceText: string): string {
	const verbatim = new Set<string>();
	const distinctive = new Map<string, string>();
	const acronyms = new Map<string, string>();
	const shouty = isShoutySource(sourceText);
	for (const [token] of sourceText.matchAll(TITLE_WORD)) {
		verbatim.add(token);
		if (isDistinctiveCasing(token)) {
			const lower = token.toLowerCase();
			if (!distinctive.has(lower)) distinctive.set(lower, token);
		} else if (!shouty && isAllCapsAcronym(token)) {
			const lower = token.toLowerCase();
			if (!acronyms.has(lower)) acronyms.set(lower, token);
		}
	}
	return title.replace(TITLE_WORD, token => {
		if (verbatim.has(token)) return token;
		const lower = token.toLowerCase();
		const restored = distinctive.get(lower);
		if (restored) return restored;
		if (isTitleCasedArtifact(token)) {
			const acronym = acronyms.get(lower);
			if (acronym) return acronym;
		}
		return isCamelArtifact(token) ? lower : token;
	});
}

function isDistinctiveCasing(token: string): boolean {
	return /\p{Ll}/u.test(token) && /\p{L}\p{Lu}/u.test(token);
}

function isAllCapsAcronym(token: string): boolean {
	if (!isAllCapsWord(token)) return false;
	const upper = token.toUpperCase();
	if (COMMON_TITLE_ACRONYMS.has(upper)) return true;
	if (/\p{N}/u.test(token)) return true;
	return !/[AEIOU]/.test(upper);
}

function isAllCapsWord(token: string): boolean {
	const letters = token.match(/\p{L}/gu);
	if (!letters || letters.length < 2) return false;
	return /\p{Lu}/u.test(token) && !/\p{Ll}/u.test(token);
}

function isTitleCasedArtifact(token: string): boolean {
	if (!/^\p{Lu}/u.test(token)) return false;
	if (!/\p{Ll}/u.test(token)) return false;
	return !/\p{Lu}/u.test(token.slice(1));
}

function isShoutySource(sourceText: string): boolean {
	let run = 0;
	for (const [token] of sourceText.matchAll(TITLE_WORD)) {
		if (isAllCapsWord(token)) {
			run += 1;
			if (run >= 2) return true;
		} else {
			run = 0;
		}
	}
	return false;
}

function isCamelArtifact(token: string): boolean {
	return /^\p{Ll}/u.test(token) && /\p{Lu}/u.test(token);
}
