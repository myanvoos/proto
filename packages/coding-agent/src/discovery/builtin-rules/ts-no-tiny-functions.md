---
description: "Do not extract named one-return functions or expression-bodied variable arrows that only wrap an expression — inline them"
scope: "tool:bash"
interruptMode: never
match:
  if: { lang: [ts, tsx, mts, cts, js, jsx, mjs, cjs] }
  then:
    any:
      - regex: "(?m)(?:^|[;{}])[ \\t]*(?:async[ \\t]+)?function(?:[ \\t]*\\*[ \\t]*|[ \\t]+)[\\w$]+\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}"
        in: code
      - regex: "(?m)(?:^|[;{}])[ \\t]*(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*[^{\\s][^{\\n]*$"
        in: code
      - regex: "(?m)(?:^|[;{}])[ \\t]*(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:function\\b[^(]*\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*)\\{\\s*return [^;{}\\n]+;?\\s*\\}"
        in: code
      - regex: "(?m)(?:^|[;{}])[ \\t]*(?:(?:private[ \\t]+(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?#[\\w$]+)\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}|(?:private[ \\t]+(?:static[ \\t]+)?(?:readonly[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:readonly[ \\t]+)?#[\\w$]+)\\s*(?::[^=\\n]+)?=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*(?:\\{\\s*return [^;{}\\n]+;?\\s*\\}|[^{\\s][^{\\n]*$))"
        in: code
  else:
    all:
      - any:
          - regex: "(?m)(?:async[ \\t]+)?function(?:[ \\t]*\\*[ \\t]*|[ \\t]+)[\\w$]+\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}"
            in: [code, string]
          - regex: "(?m)(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*[^{\\s][^{\\n]*$"
            in: [code, string]
          - regex: "(?m)(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:function\\b[^(]*\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*)\\{\\s*return [^;{}\\n]+;?\\s*\\}"
            in: [code, string]
          - regex: "(?m)(?:(?:private[ \\t]+(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?#[\\w$]+)\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}|(?:private[ \\t]+(?:static[ \\t]+)?(?:readonly[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:readonly[ \\t]+)?#[\\w$]+)\\s*(?::[^=\\n]+)?=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*(?:\\{\\s*return [^;{}\\n]+;?\\s*\\}|[^{\\s][^{\\n]*$))"
            in: [code, string]
      - llm: "Does this content actually define a local function whose whole body is a single expression, rather than quoting or discussing one?"
---

Inline functions whose whole body: one expression or `return`, unless name creates a durable contract.

## Why

- One-line wrappers: no real behavior.
- Readers: jump to verify trivial code.
- Signature: freezes shape too early.
- Inline expressions: better search and type flow.

## Avoid

```typescript
// Bad — pure rename, no behavior added.
function isEmpty(value: string): boolean {
	return value.length === 0;
}

const getDisplayName = (user: User) => user.profile.displayName;

function double(value: number) {
	return value * 2;
}

if (isEmpty(name)) { ... }
```

## Use

```typescript
if (name.length === 0) { ... }
const displayName = user.profile.displayName;
const doubled = value * 2;
```

## Allowed tiny functions

- Three or more call sites need lockstep behavior.
- Exported name: stable domain concept.
- Callback identity matters.
- Type guard preserves narrowing.
- Public API, test seam, or DI boundary needs indirection.
- Names non-obvious formula or magic-constant computation the inlined expression would not explain alone.

If none apply, inline it.
