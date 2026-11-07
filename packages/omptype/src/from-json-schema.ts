import { compileAllows } from "./compile";
import { OmpErrors } from "./errors";
import { type EmbeddableSchema, type IR, IR_BRAND } from "./ir";
import type { Issue } from "./jsonschema/interpret";
import { Validator, type ValidatorOptions } from "./jsonschema/validator";
import { keywordIR } from "./keywords";
import { type BaseType, type } from "./type";

/**
 * `format` values asserted by default, carried over from the importer this
 * validator replaces. Draft 2020-12 treats `format` as an annotation; proto
 * asserted the formats its tool schemas rely on, so they stay checks here and
 * `options.formats` overrides or extends them.
 */
const FORMAT_KEYWORDS: Record<string, string> = {
	email: "string.email",
	uuid: "string.uuid",
	"date-time": "string.date.iso",
	date: "string.date.iso",
	ipv4: "string.ip.v4",
	ipv6: "string.ip.v6",
	regex: "string.regex",
};

let builtinFormats: Record<string, (value: string) => boolean> | undefined;

function defaultFormats(): Record<string, (value: string) => boolean> {
	if (builtinFormats !== undefined) return builtinFormats;
	const formats: Record<string, (value: string) => boolean> = {};
	for (const name in FORMAT_KEYWORDS) {
		const ir = keywordIR(FORMAT_KEYWORDS[name]);
		if (ir !== undefined) formats[name] = compileAllows(ir);
	}
	builtinFormats = formats;
	return formats;
}

/** Options for {@link fromJsonSchema}. */
export type FromJsonSchemaOptions = ValidatorOptions;

/**
 * Build a callable omptype schema from a JSON Schema document.
 *
 * Validates exactly as JSON Schema drafts 2020-12 and 7 specify: every
 * keyword including `$dynamicRef`, `unevaluatedProperties`/`unevaluatedItems`,
 * `$id`/`$anchor` resolution, remote references, and vocabularies declared by
 * meta-schemas. The result is a regular omptype schema: callable, composable,
 * emitting the source document from `toJsonSchema()`, and filling absent
 * properties from their `default` when called (never in `allows`).
 *
 * # Errors
 * Throws `OmpTypeError` when a `$ref` is malformed or names a document or
 * location that neither `schema` nor `options.schemas` contains, when a
 * `pattern` is not a regular expression, or when a schema node is neither a
 * boolean nor an object.
 */
export function fromJsonSchema(schema: unknown, options?: FromJsonSchemaOptions): BaseType {
	const validator = new Validator(
		schema,
		{
			...options,
			fillDefaultedRequired: options?.fillDefaultedRequired ?? true,
			formats: { ...defaultFormats(), ...options?.formats },
		},
		compiled => {
			imported.allows = compiled;
		},
	);
	const check = validator.check;
	const node = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
	const refine: IR = {
		k: "refine",
		base: { k: "unknown" },
		check,
		pred: value => check(value) || toErrors(validator.explain(value), value),
		expected: "a value matching the JSON Schema",
		json: node ?? (schema === false ? { not: {} } : {}),
	};
	if (typeof node?.description === "string") refine.desc = node.description;
	const ir: IR = validator.hasDefaults
		? { k: "morph", input: refine, fn: value => validator.fillDefaults(value) }
		: refine;
	const embedded: EmbeddableSchema = {
		[IR_BRAND]: true,
		ir,
		hasSteps: false,
		hasDefault: false,
		run: value => value,
	};
	const imported = type.raw(embedded);
	// The engine's check is the whole boolean path; skip the generic dispatcher.
	// Once generated code exists, `onCompile` above rebinds `allows` to it.
	Object.defineProperty(imported, "allows", { value: check, writable: true, configurable: true });
	return imported;
}

function toErrors(issues: readonly Issue[], value: unknown): OmpErrors {
	if (issues.length === 0) return new OmpErrors([], "a value matching the JSON Schema", value);
	const errors = new OmpErrors(issues[0].path, issues[0].expected, issues[0].data);
	for (let index = 1; index < issues.length; index++) {
		const issue = issues[index];
		errors.append(new OmpErrors(issue.path, issue.expected, issue.data));
	}
	return errors;
}
