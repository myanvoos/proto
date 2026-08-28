const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export function magicKeywordRegex(keyword: string, flags = ""): RegExp {
	const normalizedFlags = flags.includes("u") ? flags : `${flags}u`;
	return new RegExp(`${LEFT_BOUNDARY}${escapeRegExp(keyword)}${RIGHT_BOUNDARY}`, normalizedFlags);
}
