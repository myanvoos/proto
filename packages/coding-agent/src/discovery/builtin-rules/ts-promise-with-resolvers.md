---
description: Use Promise.withResolvers() instead of new Promise() constructor
scope: "tool:bash"
interruptMode: never
match:
  if: { lang: [ts, tsx, mts, cts, js, jsx, mjs, cjs] }
  then:
    regex: "\\bnew\\s+Promise(?=(?:<(?:[^<>()=]|=(?!>)|=>|<[^<>]*>|\\([^()]*\\))*>)?\\(\\s*(?:/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/\\s*)*(?:async\\s+(?:/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/\\s*)*)?(?:\\((?:\\s|/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/)*[^\\s)/]|function\\b[^(]*\\((?:\\s|/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/)*[^\\s)/]|(?!(?:function|async)(?![\\w$]))[A-Za-z_$][\\w$]*(?=[^\\w$])))"
    in: code
  else:
    all:
      - regex: "\\bnew\\s+Promise(?=(?:<(?:[^<>()=]|=(?!>)|=>|<[^<>]*>|\\([^()]*\\))*>)?\\(\\s*(?:/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/\\s*)*(?:async\\s+(?:/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/\\s*)*)?(?:\\((?:\\s|/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/)*[^\\s)/]|function\\b[^(]*\\((?:\\s|/\\*[^*]*\\*+(?:[^/*][^*]*\\*+)*/)*[^\\s)/]|(?!(?:function|async)(?![\\w$]))[A-Za-z_$][\\w$]*(?=[^\\w$])))"
        in: [code, string]
      - llm: "Does this content actually construct a promise with an executor that takes a resolver, rather than quoting or discussing it?"
---

Prefer `Promise.withResolvers()` over `new Promise((resolve, reject) => ...)`: linear control flow; typed resolvers without callback nesting.

## Basic operation

```typescript
// Bad
function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

// Good
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
```

## Event-based completion

```typescript
// Bad
function waitForEvent(emitter: EventEmitter, event: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		emitter.once(event, resolve);
		emitter.once("error", reject);
	});
}

// Good
function waitForEvent(emitter: EventEmitter, event: string): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	emitter.once(event, resolve);
	emitter.once("error", reject);
	return promise;
}
```

## Stored resolver

```typescript
class Gate {
	#promise: Promise<void>;
	#resolve: () => void;

	constructor() {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#promise = promise;
		this.#resolve = resolve;
	}

	open(): void { this.#resolve(); }
	wait(): Promise<void> { return this.#promise; }
}
```

Constructor only if an API specifically requires executor form.
