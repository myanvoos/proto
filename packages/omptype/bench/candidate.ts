import type { Def } from "./ir";

export type SchemaFn = (value: unknown) => unknown;

export type CheckFn = (value: unknown) => boolean;

export interface Candidate {
	name: string;
	type(def: Def): SchemaFn;

	allows?(def: Def): CheckFn;
	isErrors(result: unknown): boolean;

	summary?(result: unknown): string;
}
