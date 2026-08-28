import type { Component } from "../tui";

export class Spacer implements Component {
	#lines: number;
	#cached: string[] | undefined;

	constructor(lines: number = 1) {
		this.#lines = lines;
	}

	setLines(lines: number): void {
		if (lines === this.#lines) return;
		this.#lines = lines;
		this.#cached = undefined;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		let cached = this.#cached;
		if (cached === undefined) {
			cached = new Array(this.#lines).fill("");
			this.#cached = cached;
		}
		return cached;
	}
}
