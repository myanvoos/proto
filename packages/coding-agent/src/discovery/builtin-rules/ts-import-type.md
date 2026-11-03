---
description: "Use `import type`, not inline `import('pkg').Type` or indexed type references"
scope: "tool:bash"
interruptMode: never
match:
  if: { lang: [ts, tsx, mts, cts, js, jsx, mjs, cjs] }
  then:
    any:
      - regex: "\\btypeof\\s+import\\("
        in: code
      - regex: "\\bimport(?=\\((?:\\s|//.*|/\\*(?:[^*]|\\*(?!/))*\\*/)*(?:\"[^\"\\n]*\"|'[^'\\n]*'|\\x60[^\\x60]*\\x60)(?:\\s|//.*|/\\*(?:[^*]|\\*(?!/))*\\*/)*(?:,[^()]*)?\\)\\s*(?:\\[\\s*[\"']|\\.\\s*(?!(?:then|catch|finally)(?![\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF]))[A-Za-z_$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF][\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF]*(?=[^\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF])))"
        in: code
  else:
    all:
      - any:
          - regex: "\\btypeof\\s+import\\("
            in: [code, string]
          - regex: "\\bimport(?=\\((?:\\s|//.*|/\\*(?:[^*]|\\*(?!/))*\\*/)*(?:\"[^\"\\n]*\"|'[^'\\n]*'|\\x60[^\\x60]*\\x60)(?:\\s|//.*|/\\*(?:[^*]|\\*(?!/))*\\*/)*(?:,[^()]*)?\\)\\s*(?:\\[\\s*[\"']|\\.\\s*(?!(?:then|catch|finally)(?![\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF]))[A-Za-z_$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF][\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF]*(?=[^\\w$\\u00AA-\\u167F\\u1681-\\u1FFF\\u200B-\\u2027\\u202A-\\u202E\\u2030-\\u205E\\u2060-\\u2FFF\\u3001-\\uFEFE\\uFF00-\\uFFFF])))"
            in: [code, string]
      - llm: "Does this content actually use an inline import type reference rather than quoting or discussing it?"
---

Use top-level `import type` declarations for type-only dependencies. NEVER write `import("pkg").Type` inside source annotations.

## Why

- Top-level imports expose dependencies immediately.
- Import sorting and deduplication can manage them.
- Signatures stay readable and reviewable.
- Re-exports do not inherit noisy inline paths.

## Avoid

```typescript
// Bad — inline imports hide dependencies in signatures.
function run(client: import("some-sdk").Client, input: import("arktype").infer<Schema>): Promise<Output>;

// Bad — annotations become path dumps.
const options: import("some-sdk/config").ClientOptions = { ... };
```

## Use

```typescript
import type { Client } from "some-sdk";
import type { ClientOptions } from "some-sdk/config";
import type { infer as Infer } from "arktype";

function run(client: Client, input: Infer<Schema>): Promise<Output>;
const options: ClientOptions = { ... };
```

## Exceptions

- Ambient `.d.ts` globals that must not become modules.
- Generated files whose generator owns import management.

In normal `.ts` / `.tsx` source, use `import type`.
