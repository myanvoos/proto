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
			target = typeof defs === "object" && defs !== null ? (defs as JsonSchema)[defsMatch[2]] : undefined;
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
		if (typeof node.not === "object" && node.not !== null && Object.keys(node.not).length === 0) {
			constraints.push({ k: "never" });
		}

		if (Array.isArray(node.type)) {
			constraints.push(union(node.type.map(kind => this.#lowerTyped(node, String(kind)))));
		} else if (typeof node.type === "string") {
			constraints.push(this.#lowerTyped(node, node.type));
		} else if (node.properties !== undefined || node.required !== undefined) {
			constraints.push(this.#lowerObject(node));
		} else if (node.items !== undefined || node.prefixItems !== undefined) {
			constraints.push(this.#lowerArray(node));
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
		if (typeof node.minLength === "number") base.min = node.minLength;
		if (typeof node.maxLength === "number") base.max = node.maxLength;
		if (node.format === "uri" || node.format === "url") base.url = true;

		const members: IR[] = [];
		if (typeof node.format === "string") {
			const keyword = FORMAT_KEYWORDS[node.format];
			if (keyword !== undefined) {
				const formatIR = keywordIR(keyword);
				if (formatIR !== undefined) members.push(formatIR);
			}
		}
		if (typeof node.pattern === "string") members.push(patternIR(new RegExp(node.pattern)));

		if (members.length === 0) return base;
		if (base.min !== undefined || base.max !== undefined || base.url) members.unshift(base);
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
				if (typeof value === "object" && value !== null && "default" in value) {
					prop.hasDefault = true;
					prop.def = (value as JsonSchema).default;
					prop.opt = true;
				}
				props.push(prop);
			}
		}
		const extra = node.additionalProperties;
		const object: IR = {
			k: "object",
			props,
			extras: extra === false ? "reject" : "keep",
			...(typeof extra === "object" && extra !== null ? { index: this.lower(extra) } : {}),
		};
		const undeclaredRequired = [...required].filter(key => !declared.has(key));
		if (undeclaredRequired.length === 0) return object;
		return {
			k: "refine",
			base: object,
			pred: value =>
				typeof value === "object" && value !== null && undeclaredRequired.every(key => own.call(value, key)),
			expected: `an object with required own ${undeclaredRequired.length === 1 ? "property" : "properties"} ${undeclaredRequired.join(
				", ",
			)}`,
			json: { required: [...required] },
		};
	}

	#lowerArray(node: JsonSchema): IR {
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
			if (typeof node.minItems !== "number" && typeof node.maxItems !== "number") return tuple;
			const bounds: IR = { k: "array", el: { k: "unknown" } };
			if (typeof node.minItems === "number") bounds.min = node.minItems;
			if (typeof node.maxItems === "number") bounds.max = node.maxItems;
			return intersection([tuple, bounds]);
		}
		const ir: IR = { k: "array", el: node.items === undefined ? { k: "unknown" } : this.lower(node.items) };
		if (typeof node.minItems === "number") ir.min = node.minItems;
		if (typeof node.maxItems === "number") ir.max = node.maxItems;
		return ir;
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
