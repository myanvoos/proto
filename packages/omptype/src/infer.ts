type Whitespace = " " | "\n" | "\r" | "\t";

type TrimLeft<s extends string> = s extends `${Whitespace}${infer rest}` ? TrimLeft<rest> : s;
type TrimRight<s extends string> = s extends `${infer rest}${Whitespace}` ? TrimRight<rest> : s;
type Trim<s extends string> = TrimLeft<TrimRight<s>>;

type ArkAny = unknown;

interface PrimitiveMap {
	string: string;
	"string.url": string;
	number: number;
	"number.integer": number;
	"number.epoch": number;
	"number.safe": number;
	"number.NaN": number;
	"number.Infinity": number;
	"number.NegativeInfinity": number;
	boolean: boolean;
	null: null;
	undefined: undefined;
	unknown: unknown;
	"unknown.any": ArkAny;
	any: unknown;
	object: object;
	bigint: bigint;
	symbol: symbol;
	Key: PropertyKey;
	Date: Date;
	Array: unknown[];

	Function: Function;
	RegExp: RegExp;
	File: File;
	Error: Error;
	Set: Set<unknown>;
	Map: Map<unknown, unknown>;
	WeakSet: WeakSet<WeakKey>;
	WeakMap: WeakMap<WeakKey, unknown>;
	Promise: Promise<unknown>;
	FormData: FormData;
	"object.json": unknown;
	true: true;
	false: false;
}

type Merge<left, right> = left extends object
	? right extends object
		? Omit<left, keyof right> & right
		: never
	: never;

type InferUtility<s extends string> = s extends `Record<${string},${infer value}>`
	? Record<string, InferString<value>>
	: s extends `Array<${infer element}>` | `Array.liftFrom<${infer element}>`
		? InferString<element>[]
		: s extends `Partial<${infer value}>`
			? Partial<InferString<value>>
			: s extends `Required<${infer value}>`
				? Required<InferString<value>>
				: s extends `Pick<${infer value},${infer keys}>`
					? Pick<InferString<value>, Extract<InferString<keys>, keyof InferString<value>>>
					: s extends `Omit<${infer value},${infer keys}>`
						? Omit<InferString<value>, Extract<InferString<keys>, keyof InferString<value>>>
						: s extends `Merge<${infer left},${infer right}>`
							? Merge<InferString<left>, InferString<right>>
							: never;

type InferParse<s extends string> = s extends
	| "string.numeric.parse"
	| "string.integer.parse"
	| "parse.number"
	| "parse.integer"
	? number
	: s extends "string.date.parse" | "string.date.iso.parse" | "string.date.epoch.parse" | "parse.date"
		? Date
		: s extends "string.url.parse" | "parse.url"
			? URL
			: s extends "string.json.parse" | "parse.json"
				? unknown
				: s extends "object.json.stringify"
					? string
					: s extends "FormData.parse"
						? Record<string, Bun.FormDataEntryValue | Bun.FormDataEntryValue[]>
						: s extends "parse.boolean"
							? boolean
							: s extends "parse.bigint"
								? bigint
								: never;

type InferMember<member extends string> = Trim<member> extends infer s extends string ? InferMemberTrimmed<s> : unknown;

type InferMemberTrimmed<s extends string> = s extends `(${infer inner})`
	? InferString<inner>
	: s extends `${infer element}[]`
		? InferMember<element>[]
		: s extends `'${infer literal}'` | `"${infer literal}"`
			? literal
			: s extends `d'${string}'` | `d"${string}"`
				? Date
				: s extends `\`${string}\``
					? string
					: s extends `/${string}/${string}` | `/${string}/`
						? string
						: s extends `${infer literal extends number}`
							? literal
							: s extends keyof PrimitiveMap
								? PrimitiveMap[s]
								: [InferParse<s>] extends [never]
									? InferUtility<s> extends infer utility
										? [utility] extends [never]
											? InferMemberFallback<s>
											: utility
										: unknown
									: InferParse<s>;

type InferMemberFallback<s extends string> = s extends `string.${string}`
	? string
	: s extends `${string}Date${string}`
		? Date
		: s extends `${string}string${string}`
			? string
			: s extends `${string}number${string}`
				? number
				: unknown;

type InferUnion<s extends string, result = never> = s extends `${infer head}|${infer tail}`
	? InferUnion<tail, result | InferMember<head>>
	: result | InferMember<s>;

type InferMemberIn<member extends string> =
	Trim<member> extends infer s extends string
		? s extends `${string}.parse` | `parse.${string}`
			? string
			: InferMemberTrimmed<s>
		: unknown;

type InferUnionIn<s extends string, result = never> = s extends `${infer head}|${infer tail}`
	? InferUnionIn<tail, result | InferMemberIn<head>>
	: result | InferMemberIn<s>;

type HasInlineDefault<s extends string> = s extends `${string}=${string}`
	? s extends `${string}<${string}` | `${string}>${string}`
		? false
		: true
	: false;

type WithoutInlineDefault<s extends string> =
	HasInlineDefault<s> extends true ? (s extends `${infer base}=${string}` ? Trim<base> : s) : s;

type InferStringOutput<s extends string> = InferUnion<s>;

export type InferString<s extends string> =
	WithoutInlineDefault<Trim<s>> extends infer trimmed extends string
		? trimmed extends `${infer base}?`
			? InferString<base>
			: trimmed extends `(${infer inner})[]`
				? InferUnion<inner>[]
				: InferStringOutput<trimmed>
		: unknown;

export type InferStringIn<s extends string> =
	WithoutInlineDefault<Trim<s>> extends infer trimmed extends string
		? trimmed extends `${infer base}?`
			? InferStringIn<base>
			: trimmed extends `(${infer inner})[]`
				? InferUnionIn<inner>[]
				: InferUnionIn<trimmed>
		: unknown;

type HasDefault<def> = def extends string
	? HasInlineDefault<def>
	: def extends readonly [unknown, "=", unknown]
		? true
		: def extends { readonly hasDefault: true }
			? true
			: false;

type DefinitionKeys<def extends object> = Exclude<keyof def, "+" | "[string]" | "...">;

type IsOptionalProp<key, def> = key extends `${string}?`
	? true
	: def extends string
		? Trim<def> extends `${string}?`
			? true
			: false
		: def extends readonly [unknown, "?"]
			? true
			: false;

type PropName<key extends PropertyKey> = key extends `${infer name}?` ? name : key;
type UnwrapProperty<def> = def extends readonly [infer value, "?" | "=", ...unknown[]] ? value : def;
type Simplify<t> = { [key in keyof t]: t[key] };

type OutputRequired<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? HasDefault<def[key]> extends true
			? PropName<key>
			: never
		: PropName<key>]-?: InferDef<UnwrapProperty<def[key]>>;
};

type OutputOptional<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? HasDefault<def[key]> extends true
			? never
			: PropName<key>
		: never]?: InferDef<UnwrapProperty<def[key]>>;
};

type InputRequired<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? never
		: HasDefault<def[key]> extends true
			? never
			: PropName<key>]-?: InferDefIn<UnwrapProperty<def[key]>>;
};

type InputOptional<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? PropName<key>
		: HasDefault<def[key]> extends true
			? PropName<key>
			: never]?: InferDefIn<UnwrapProperty<def[key]>>;
};

interface DefBox<def> {
	readonly out: InferDef<def>;
	readonly in: InferDefIn<def>;
}

type OutputSpread<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["out"] : unknown;
type InputSpread<def extends object> = "..." extends keyof def ? DefBox<def["..."]>["in"] : unknown;
type OutputIndex<def extends object> = "[string]" extends keyof def
	? Record<string, DefBox<def["[string]"]>["out"]>
	: unknown;
type InputIndex<def extends object> = "[string]" extends keyof def
	? Record<string, DefBox<def["[string]"]>["in"]>
	: unknown;

type InferObject<def extends object> = "[string]" extends keyof def
	? [DefinitionKeys<def>] extends [never]
		? Record<string, DefBox<def["[string]"]>["out"]>
		: Simplify<OutputRequired<def> & OutputOptional<def> & OutputSpread<def>> & OutputIndex<def>
	: Simplify<OutputRequired<def> & OutputOptional<def> & OutputSpread<def>>;

type InferObjectIn<def extends object> = "[string]" extends keyof def
	? [DefinitionKeys<def>] extends [never]
		? Record<string, DefBox<def["[string]"]>["in"]>
		: Simplify<InputRequired<def> & InputOptional<def> & InputSpread<def>> & InputIndex<def>
	: Simplify<InputRequired<def> & InputOptional<def> & InputSpread<def>>;

export type InferObjectDef<def extends object> = InferObject<def>;

type InferLiteralDef<def> = def extends { readonly infer: infer output }
	? output
	: def extends string
		? InferString<def>
		: def extends object
			? InferObjectLiteral<def>
			: unknown;

type InferLiteralDefIn<def> = def extends { readonly inferIn: infer input }
	? input
	: def extends string
		? InferStringIn<def>
		: def extends object
			? InferObjectLiteralIn<def>
			: unknown;

type LiteralRequired<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? HasDefault<def[key]> extends true
			? PropName<key>
			: never
		: PropName<key>]-?: InferLiteralDef<UnwrapProperty<def[key]>>;
};

type LiteralOptional<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? HasDefault<def[key]> extends true
			? never
			: PropName<key>
		: never]?: InferLiteralDef<UnwrapProperty<def[key]>>;
};

type LiteralRequiredIn<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? never
		: HasDefault<def[key]> extends true
			? never
			: PropName<key>]-?: InferLiteralDefIn<UnwrapProperty<def[key]>>;
};

type LiteralOptionalIn<def extends object> = {
	-readonly [key in DefinitionKeys<def> as IsOptionalProp<key, def[key]> extends true
		? PropName<key>
		: HasDefault<def[key]> extends true
			? PropName<key>
			: never]?: InferLiteralDefIn<UnwrapProperty<def[key]>>;
};

export type InferObjectLiteral<def extends object> = Simplify<LiteralRequired<def> & LiteralOptional<def>>;

export type InferObjectLiteralIn<def extends object> = Simplify<LiteralRequiredIn<def> & LiteralOptionalIn<def>>;

type InstanceOf<ctor> = ctor extends abstract new (...args: never[]) => infer instance ? instance : never;
type SpreadOutput<def> = InferDef<def> extends readonly (infer element)[] ? element[] : never[];
type SpreadInput<def> = InferDefIn<def> extends readonly (infer element)[] ? element[] : never[];

type InferTupleOutput<defs extends readonly unknown[], result extends unknown[] = []> = defs extends readonly []
	? result
	: defs extends readonly ["...", infer spread, ...infer rest]
		? [...result, ...SpreadOutput<spread>, ...InferTupleOutput<rest>]
		: defs extends readonly [infer head, ...infer rest]
			? head extends readonly [infer value, "?"]
				? InferTupleOutput<rest, [...result, InferDef<value>?]>
				: head extends readonly [infer value, "=", unknown]
					? InferTupleOutput<rest, [...result, InferDef<value>]>
					: InferTupleOutput<rest, [...result, InferDef<head>]>
			: result;

type InferTupleInput<defs extends readonly unknown[], result extends unknown[] = []> = defs extends readonly []
	? result
	: defs extends readonly ["...", infer spread, ...infer rest]
		? [...result, ...SpreadInput<spread>, ...InferTupleInput<rest>]
		: defs extends readonly [infer head, ...infer rest]
			? head extends readonly [infer value, "?" | "=", ...unknown[]]
				? InferTupleInput<rest, [...result, InferDefIn<value>?]>
				: InferTupleInput<rest, [...result, InferDefIn<head>]>
			: result;

type IsAny<def> = 0 extends 1 & def ? true : false;

export type InferDef<def = unknown> =
	IsAny<def> extends true
		? unknown
		: def extends { readonly infer: infer output }
			? output
			: def extends string
				? InferString<def>
				: def extends RegExp
					? string
					: def extends readonly [infer element, "[]"]
						? InferDef<element>[]
						: def extends readonly [infer left, "|", infer right]
							? InferDef<left> | InferDef<right>
							: def extends readonly [infer left, "&", infer right]
								? InferDef<left> & InferDef<right>
								: def extends readonly [unknown, "=>", (...args: never[]) => infer output]
									? output
									: def extends readonly [unknown, "|>", infer output]
										? InferDef<output>
										: def extends readonly [infer base, ":", unknown] | readonly [infer base, "@", unknown]
											? InferDef<base>
											: def extends readonly ["keyof", infer base]
												? keyof InferDef<base>
												: def extends readonly ["instanceof", ...infer constructors]
													? InstanceOf<constructors[number]>
													: def extends readonly ["===", ...infer values]
														? values[number]
														: def extends readonly unknown[]
															? InferTupleOutput<def>
															: def extends object
																? InferObject<def>
																: unknown;

export type InferDefIn<def = unknown> =
	IsAny<def> extends true
		? unknown
		: def extends { readonly inferIn: infer input }
			? input
			: def extends string
				? InferStringIn<def>
				: def extends RegExp
					? string
					: def extends readonly [infer element, "[]"]
						? InferDefIn<element>[]
						: def extends readonly [infer left, "|", infer right]
							? InferDefIn<left> | InferDefIn<right>
							: def extends readonly [infer left, "&", infer right]
								? InferDefIn<left> & InferDefIn<right>
								: def extends readonly [infer input, "=>", unknown] | readonly [infer input, "|>", unknown]
									? InferDefIn<input>
									: def extends readonly [infer base, ":", unknown] | readonly [infer base, "@", unknown]
										? InferDefIn<base>
										: def extends readonly ["keyof", infer base]
											? keyof InferDefIn<base>
											: def extends readonly ["instanceof", ...infer constructors]
												? InstanceOf<constructors[number]>
												: def extends readonly ["===", ...infer values]
													? values[number]
													: def extends readonly unknown[]
														? InferTupleInput<def>
														: def extends object
															? InferObjectIn<def>
															: unknown;
