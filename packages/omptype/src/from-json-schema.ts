import { OmpErrors, OmpTypeError } from "./errors";
import { walk } from "./interp";
import { type EmbeddableSchema, type IR, IR_BRAND, type PropIR, type TupleItemIR } from "./ir";
import { keywordIR, patternIR } from "./keywords";
import { type BaseType, type } from "./type";

type JsonSchema = Record<string, unknown>;

const FORMAT_KEYWORDS: Record<string, string> = {
	email: "string.email",
	uuid: "string.uuid",
	"date-time": "string.date.iso",
	date: "string.date.iso",
	ipv4: "string.ip.v4",
	ipv6: "string.ip.v6",
	regex: "string.regex",
};

const own = Object.prototype.hasOwnProperty;

function intersection(members: IR[]): IR {
	if (members.some(member => member.k === "never")) return { k: "never" };
	const constrained = members.filter(member => member.k !== "unknown");
	if (constrained.length === 0) return { k: "unknown" };
	return constrained.length === 1 ? constrained[0] : { k: "intersection", members: constrained };
}

function union(members: IR[]): IR {
	if (members.some(member => member.k === "unknown")) return { k: "unknown" };
	if (members.length === 0) return { k: "never" };
	return members.length === 1 ? members[0] : { k: "union", members };
}

function jsonEquals(expected: unknown, actual: unknown): boolean {
	if (expected === actual) return true;
	if (expected instanceof Date) return actual instanceof Date && actual.valueOf() === expected.valueOf();
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) return false;
		for (let index = 0; index < expected.length; index++) {
			if (!jsonEquals(expected[index], actual[index])) return false;
		}
		return true;
	}
	if (
		typeof expected !== "object" ||
		expected === null ||
		typeof actual !== "object" ||
		actual === null ||
		Array.isArray(actual) ||
		actual instanceof Date
	) {
		return false;
	}
	const expectedKeys = Object.keys(expected);
	const actualKeys = Object.keys(actual);
	if (actualKeys.length !== expectedKeys.length) return false;
	const expectedRecord = expected as Record<string, unknown>;
	const actualRecord = actual as Record<string, unknown>;
	for (const key of expectedKeys) {
		if (!own.call(actualRecord, key) || !jsonEquals(expectedRecord[key], actualRecord[key])) return false;
	}
	return true;
}

function codePointLength(value: string): number {
	let length = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) index++;
		}
		length++;
	}
	return length;
}

function kindMatches(kind: "object" | "array" | "number" | "string", value: unknown): boolean {
	switch (kind) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "string":
			return typeof value === "string";
	}
}

function uniqueItemsIR(): IR {
	return {
		k: "refine",
		base: { k: "unknown" },
		pred: value => {
			if (!Array.isArray(value)) return true;
			for (let i = 0; i < value.length; i++) {
				for (let j = i + 1; j < value.length; j++) {
					if (jsonEquals(value[i], value[j])) return false;
				}
			}
			return true;
		},
		expected: "an array of unique items",
		json: { uniqueItems: true },
	};
}

function literal(value: unknown): IR {
	if (value === null || typeof value !== "object" || value instanceof Date) return { k: "lit", v: value };
	const base: IR = Array.isArray(value)
		? { k: "array", el: { k: "unknown" } }
		: { k: "object", props: [], extras: "keep" };
	return {
		k: "refine",
		base,
		pred: candidate => jsonEquals(value, candidate),
		expected: "the configured JSON value",
		json: { const: value },
	};
}

function matchesExactlyOne(members: IR[], value: unknown): boolean {
	let matched = false;
	for (const member of members) {
		if (walk(member, value) instanceof OmpErrors) continue;
		if (matched) return false;
		matched = true;
	}
	return matched;
}

class Importer {
	readonly #root: JsonSchema;
	readonly #aliases = new Map<string, IR>();

	constructor(root: JsonSchema) {
		this.#root = root;
	}

	resolveRef(ref: string): IR {
		const cached = this.#aliases.get(ref);
		if (cached !== undefined) return cached;

		let target: unknown;
		if (ref === "#") {
			target = this.#root;
		} else {
			const defsMatch = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
			if (defsMatch === null) throw new OmpTypeError(`unsupported $ref: ${ref}`);
			const defs = this.#root[defsMatch[1]];
			const token = defsMatch[2].replace(/~1/g, "/").replace(/~0/g, "~");
			target = typeof defs === "object" && defs !== null ? (defs as JsonSchema)[token] : undefined;
			if (target === undefined) throw new OmpTypeError(`unresolved $ref: ${ref}`);
		}

		let lowered: IR | undefined;
		const alias: IR = {
			k: "alias",
			name: ref,
			resolve: () => {
				lowered ??= this.lower(target);
				return lowered;
			},
		};
		this.#aliases.set(ref, alias);
		return alias;
	}

	lower(schema: unknown): IR {
		if (schema === true) return { k: "unknown" };
		if (schema === false) return { k: "never" };
		if (typeof schema !== "object" || schema === null) {
			throw new OmpTypeError("JSON Schema nodes must be booleans or objects");
		}
		const node = schema as JsonSchema;
		const desc = typeof node.description === "string" ? node.description : undefined;
		const ir = this.#lowerNode(node);
		return desc === undefined ? ir : { ...ir, desc };
	}

	#lowerNode(node: JsonSchema): IR {
		const constraints: IR[] = [];
		if (typeof node.$ref === "string") constraints.push(this.resolveRef(node.$ref));

		if (Array.isArray(node.enum)) constraints.push(union(node.enum.map(value => literal(value))));
		if ("const" in node) constraints.push(literal(node.const));

		if (Array.isArray(node.anyOf)) {
			constraints.push(union(node.anyOf.map(branch => this.lower(branch))));
		}
		if (Array.isArray(node.oneOf)) {
			const members = node.oneOf.map(branch => this.lower(branch));
			constraints.push({
				k: "refine",
				base: { k: "unknown" },
				pred: value => matchesExactlyOne(members, value),
				expected: "exactly one matching oneOf branch",
				json: { oneOf: node.oneOf },
			});
		}
		if (Array.isArray(node.allOf)) {
			constraints.push(...node.allOf.map(branch => this.lower(branch)));
		}
		if (node.not !== undefined) constraints.push(this.#lowerNot(node.not));

		const nullAllowed = node.nullable === true;
		if (Array.isArray(node.type)) {
			const kinds = node.type.map(kind => String(kind));
			const members = kinds.map(kind => this.#lowerTyped(node, kind));
			if (nullAllowed && !kinds.includes("null")) members.push({ k: "null" });
			constraints.push(union(members));
		} else if (typeof node.type === "string") {
			const typed = this.#lowerTyped(node, node.type);
			constraints.push(nullAllowed ? union([typed, { k: "null" }]) : typed);
		} else {
			// Without a `type`, JSON Schema keywords constrain only values of their kind;
			// every other value passes. Lower each present keyword group conditionally.
			const conditionals: IR[] = [];
			if (
				node.properties !== undefined ||
				node.required !== undefined ||
				node.patternProperties !== undefined ||
				node.additionalProperties !== undefined ||
				node.minProperties !== undefined ||
				node.maxProperties !== undefined
			) {
				conditionals.push(this.#lowerConditional(node, "object"));
			}
			if (
				node.items !== undefined ||
				node.prefixItems !== undefined ||
				node.uniqueItems !== undefined ||
				node.contains !== undefined
			) {
				conditionals.push(this.#lowerConditional(node, "array"));
			}
			if (
				typeof node.minimum === "number" ||
				typeof node.maximum === "number" ||
				typeof node.exclusiveMinimum === "number" ||
				typeof node.exclusiveMaximum === "number" ||
				typeof node.multipleOf === "number"
			) {
				conditionals.push(this.#lowerConditional(node, "number"));
			}
			if (
				typeof node.minLength === "number" ||
				typeof node.maxLength === "number" ||
				typeof node.pattern === "string" ||
				typeof node.format === "string"
			) {
				conditionals.push(this.#lowerConditional(node, "string"));
			}
			if (conditionals.length > 0) {
				const combined = intersection(conditionals);
				constraints.push(nullAllowed ? union([combined, { k: "null" }]) : combined);
			}
		}

		return intersection(constraints);
	}

	#lowerTyped(node: JsonSchema, kind: string): IR {
		switch (kind) {
			case "null":
				return { k: "null" };
			case "boolean":
				return { k: "boolean" };
			case "string":
				return this.#lowerString(node);
			case "number":
			case "integer": {
				const ir: IR = { k: "number" };
				if (kind === "integer") ir.int = true;
				if (typeof node.minimum === "number") ir.min = node.minimum;
				if (typeof node.maximum === "number") ir.max = node.maximum;
				if (typeof node.exclusiveMinimum === "number") {
					ir.min = node.exclusiveMinimum;
					ir.xmin = true;
				}
				if (typeof node.exclusiveMaximum === "number") {
					ir.max = node.exclusiveMaximum;
					ir.xmax = true;
				}
				if (typeof node.multipleOf === "number") ir.divisor = node.multipleOf;
				return ir;
			}
			case "object":
				return this.#lowerObject(node);
			case "array":
				return this.#lowerArray(node);
			default:
				throw new OmpTypeError(`unsupported JSON Schema type: ${kind}`);
		}
	}

	#lowerString(node: JsonSchema): IR {
		const base: IR = { k: "string" };
		if (node.format === "uri" || node.format === "url") base.url = true;

		// JSON Schema counts length in code points, not UTF-16 code units
		const members: IR[] = [];
		if (typeof node.minLength === "number") {
			const min = node.minLength;
			members.push({
				k: "refine",
				base: { k: "string" },
				pred: value => codePointLength(value as string) >= min,
				expected: `a string (length at least ${min} characters)`,
				json: { minLength: min },
			});
		}
		if (typeof node.maxLength === "number") {
			const max = node.maxLength;
			members.push({
				k: "refine",
				base: { k: "string" },
				pred: value => codePointLength(value as string) <= max,
				expected: `a string (length at most ${max} characters)`,
				json: { maxLength: max },
			});
		}
		if (typeof node.format === "string") {
			const keyword = FORMAT_KEYWORDS[node.format];
			if (keyword !== undefined) {
				const formatIR = keywordIR(keyword);
				if (formatIR !== undefined) members.push(formatIR);
			}
		}
		if (typeof node.pattern === "string") members.push(patternIR(new RegExp(node.pattern)));

		if (members.length === 0) return base;
		if (base.url) members.unshift(base);
		return members.length === 1 ? members[0] : { k: "intersection", members };
	}

	#lowerObject(node: JsonSchema): IR {
		const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
		const declared = new Set<string>();
		const props: PropIR[] = [];
		if (typeof node.properties === "object" && node.properties !== null) {
			for (const [key, value] of Object.entries(node.properties)) {
				declared.add(key);
				const prop: PropIR = { key, opt: !required.has(key), val: this.lower(value) };
				// JSON Schema marks `default` as an annotation, but proto deliberately fills a
				// missing required property from its default so models omitting such arguments
				// still produce usable calls. `required` without a default is still enforced.
				if (typeof value === "object" && value !== null && "default" in value) {
					prop.hasDefault = true;
					prop.def = (value as JsonSchema).default;
					prop.opt = true;
				}
				props.push(prop);
			}
		}
		const patternIndexes: { key: IR; val: IR }[] = [];
		if (typeof node.patternProperties === "object" && node.patternProperties !== null) {
			for (const [pattern, value] of Object.entries(node.patternProperties)) {
				patternIndexes.push({ key: patternIR(new RegExp(pattern)), val: this.lower(value) });
			}
		}
		const extra = node.additionalProperties;
		const object: IR = {
			k: "object",
			props,
			extras: extra === false ? "reject" : "keep",
			...(patternIndexes.length > 0 ? { patternIndexes } : {}),
			// additionalProperties applies only to keys matched by neither properties nor
			// patternProperties; the interpreter skips declared and pattern-matched keys.
			...(extra !== false && typeof extra === "object" && extra !== null ? { index: this.lower(extra) } : {}),
		};

		const members: IR[] = [object];
		const bounds = this.#lowerPropertyCountBounds(node);
		if (bounds !== undefined) members.push(bounds);
		const undeclaredRequired = [...required].filter(key => !declared.has(key));
		if (undeclaredRequired.length > 0) {
			members.push({
				k: "refine",
				base: { k: "unknown" },
				pred: value =>
					typeof value === "object" && value !== null && undeclaredRequired.every(key => own.call(value, key)),
				expected: `an object with required own ${undeclaredRequired.length === 1 ? "property" : "properties"} ${undeclaredRequired.join(
					", ",
				)}`,
				json: { required: [...required] },
			});
		}
		return members.length === 1 ? members[0] : intersection(members);
	}

	#lowerPropertyCountBounds(node: JsonSchema): IR | undefined {
		const min = typeof node.minProperties === "number" ? node.minProperties : undefined;
		const max = typeof node.maxProperties === "number" ? node.maxProperties : undefined;
		if (min === undefined && max === undefined) return undefined;
		const expected =
			min !== undefined && max !== undefined
				? `an object with ${min} to ${max} properties`
				: min !== undefined
					? `an object with at least ${min} properties`
					: `an object with at most ${max} properties`;
		return {
			k: "refine",
			base: { k: "unknown" },
			pred: value => {
				if (typeof value !== "object" || value === null) return true;
				const count = Object.keys(value).length;
				return count >= (min ?? 0) && count <= (max ?? Number.POSITIVE_INFINITY);
			},
			expected,
			json: min !== undefined ? { minProperties: min } : { maxProperties: max },
		};
	}

	#lowerArray(node: JsonSchema): IR {
		let main: IR;
		if (Array.isArray(node.prefixItems)) {
			const prefix: TupleItemIR[] = node.prefixItems.map(item => ({
				val: this.lower(item),
				opt: true,
			}));
			const tuple: IR = {
				k: "tuple",
				prefix,
				postfix: [],
				...(node.items === false
					? {}
					: { variadic: node.items === undefined ? { k: "unknown" as const } : this.lower(node.items) }),
			};
			if (typeof node.minItems !== "number" && typeof node.maxItems !== "number") {
				main = tuple;
			} else {
				const bounds: IR = { k: "array", el: { k: "unknown" } };
				if (typeof node.minItems === "number") bounds.min = node.minItems;
				if (typeof node.maxItems === "number") bounds.max = node.maxItems;
				main = intersection([tuple, bounds]);
			}
		} else {
			const ir: IR = { k: "array", el: node.items === undefined ? { k: "unknown" } : this.lower(node.items) };
			if (typeof node.minItems === "number") ir.min = node.minItems;
			if (typeof node.maxItems === "number") ir.max = node.maxItems;
			main = ir;
		}
		const extras: IR[] = [];
		if (node.uniqueItems === true) extras.push(uniqueItemsIR());
		const contains = this.#lowerContains(node);
		if (contains !== undefined) extras.push(contains);
		if (extras.length === 0) return main;
		return intersection([main, ...extras]);
	}

	#lowerContains(node: JsonSchema): IR | undefined {
		if (node.contains === undefined) return undefined;
		const containsIR = this.lower(node.contains);
		const min = typeof node.minContains === "number" ? node.minContains : 1;
		const max = typeof node.maxContains === "number" ? node.maxContains : Number.POSITIVE_INFINITY;
		return {
			k: "refine",
			base: { k: "unknown" },
			pred: value => {
				if (!Array.isArray(value)) return true;
				let count = 0;
				for (const item of value) {
					if (!(walk(containsIR, item) instanceof OmpErrors)) count++;
					if (count > max) return false;
				}
				return count >= min;
			},
			expected:
				max === Number.POSITIVE_INFINITY
					? `an array containing at least ${min} matching item(s)`
					: `an array containing between ${min} and ${max} matching item(s)`,
			json: { contains: node.contains },
		};
	}

	#lowerConditional(node: JsonSchema, kind: "object" | "array" | "number" | "string"): IR {
		const typed = this.#lowerTyped(node, kind);
		return {
			k: "refine",
			base: { k: "unknown" },
			pred: value => (kindMatches(kind, value) ? !(walk(typed, value) instanceof OmpErrors) : true),
			expected: `a value matching the ${kind} constraints`,
			json: { type: kind },
		};
	}

	#lowerNot(child: unknown): IR {
		if (child === true) return { k: "never" };
		if (child === false) return { k: "unknown" };
		if (typeof child !== "object" || child === null) {
			throw new OmpTypeError("JSON Schema nodes must be booleans or objects");
		}
		if (Object.keys(child).length === 0) return { k: "never" };
		const childIR = this.lower(child);
		return {
			k: "refine",
			base: { k: "unknown" },
			pred: value => walk(childIR, value) instanceof OmpErrors,
			expected: "a value not matching the excluded schema",
			json: { not: child },
		};
	}
}

export function fromJsonSchema(schema: unknown): BaseType {
	const importer = new Importer(typeof schema === "object" && schema !== null ? (schema as JsonSchema) : {});
	const embedded: EmbeddableSchema = {
		[IR_BRAND]: true,
		ir: importer.lower(schema),
		hasSteps: false,
		hasDefault: false,
		run: value => value,
	};
	return type.raw(embedded);
}
