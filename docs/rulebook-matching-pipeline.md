# Rulebook Matching Pipeline

This document describes how coding-agent discovers rules from supported config formats, normalizes them into a single `Rule` shape, resolves precedence conflicts, and splits the result into:

- **Rulebook rules** (available to the model via system prompt + `rule://` URLs)
- **TTSR rules** (Time Traveling Stream Rules)

It reflects the current implementation, including partial semantics and metadata that is parsed but not enforced.

## Implementation files

- [`packages/coding-agent/src/capability/rule.ts`](../packages/coding-agent/src/capability/rule.ts)
- [`packages/coding-agent/src/capability/rule-buckets.ts`](../packages/coding-agent/src/capability/rule-buckets.ts)
- [`packages/coding-agent/src/export/ttsr-matcher.ts`](../packages/coding-agent/src/export/ttsr-matcher.ts)
- [`packages/coding-agent/src/export/ttsr-paths.ts`](../packages/coding-agent/src/export/ttsr-paths.ts)
- [`packages/coding-agent/src/export/ttsr-regions.ts`](../packages/coding-agent/src/export/ttsr-regions.ts)
- [`packages/coding-agent/src/export/ttsr.ts`](../packages/coding-agent/src/export/ttsr.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/discovery/index.ts`](../packages/coding-agent/src/discovery/index.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/proto-plugins.ts`](../packages/coding-agent/src/discovery/proto-plugins.ts)
- [`packages/coding-agent/src/discovery/builtin-defaults.ts`](../packages/coding-agent/src/discovery/builtin-defaults.ts)
- [`packages/coding-agent/src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`packages/coding-agent/src/discovery/github.ts`](../packages/coding-agent/src/discovery/github.ts)
- [`packages/coding-agent/src/discovery/cursor.ts`](../packages/coding-agent/src/discovery/cursor.ts)
- [`packages/coding-agent/src/discovery/windsurf.ts`](../packages/coding-agent/src/discovery/windsurf.ts)
- [`packages/coding-agent/src/discovery/cline.ts`](../packages/coding-agent/src/discovery/cline.ts)
- [`packages/coding-agent/src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/system-prompt.ts`](../packages/coding-agent/src/system-prompt.ts)
- [`packages/coding-agent/src/internal-urls/rule-protocol.ts`](../packages/coding-agent/src/internal-urls/rule-protocol.ts)
- [`packages/utils/src/frontmatter.ts`](../packages/utils/src/frontmatter.ts)

## 1. Canonical rule shape

All providers normalize source files into `Rule`:

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  match?: RuleMatchSpec;
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}
```

Capability identity is `rule.name` (`ruleCapability.key = rule => rule.name`).

Consequence: precedence and deduplication are **name-based only**. Two different files with the same `name` are considered the same logical rule.

## 2. Discovery sources and normalization

`src/discovery/index.ts` auto-registers providers. For `rules`, current providers are:

- `native` (priority `100`)
- `proto-plugins` (priority `90`) — `rules/*.{md,mdc}` inside configured extension package roots, normalized via the shared `buildRuleFromMarkdown` path
- `agents` (priority `70`)
- `cursor` (priority `50`)
- `windsurf` (priority `50`)
- `cline` (priority `40`)
- `github` (priority `30`)
- `builtin-defaults` (priority `1`)

### Native provider (`builtin.ts`)

Loads `.proto` rules from:

- project rules: `<cwd>/.proto/rules/*.{md,mdc}` when the cwd's `.proto/` directory is non-empty
- user rules: `<active-native-agent-dir>/rules/*.{md,mdc}`
- sticky user rule: `<active-native-agent-dir>/RULES.md`
- sticky project rule: `RULES.md` from the nearest non-empty `.proto/` directory selected while walking from cwd toward the repository root; PROTO does not continue farther when that directory lacks the file

The active native agent directory is `~/.proto/agent` by default, follows named profiles, and honors `PI_CODING_AGENT_DIR`.

Normalization:

- `name` = filename without `.md`/`.mdc`
- frontmatter parsed via `parseFrontmatter`
- `content` = body (frontmatter stripped)
- `globs`, `alwaysApply`, `description`, `match`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` are parsed by `buildRuleFromMarkdown`
- top-level `RULES.md` is synthesized as rule name `RULES` and forced to `alwaysApply: true`

Both sticky files use the fixed name `RULES`. Because native items are appended as project rules, user rules, user sticky `RULES.md`, then project sticky `RULES.md`, the first earlier item named `RULES` wins. Normally this means user sticky content shadows project sticky content; a regular `rules/RULES.md` can shadow both.

### Agents provider (`agents.ts`)

Loads from both `.agent` and `.agents` directories:

- project: walk upward from `cwd` to repo root, loading `<ancestor>/.agent/rules/*.{md,mdc}` and `<ancestor>/.agents/rules/*.{md,mdc}`
- user: `~/.agent/rules/*.{md,mdc}` and `~/.agents/rules/*.{md,mdc}`

Normalization uses the shared `buildRuleFromMarkdown` path: filename-derived name, stripped frontmatter body, and parsed `globs`, `alwaysApply`, `description`, `match`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode`.

### Cursor provider (`cursor.ts`)

Loads from:

- user: `~/.cursor/rules/*.{mdc,md}`
- project: `<cwd>/.cursor/rules/*.{mdc,md}`

Normalization (`transformMDCRule`):

- `description`: kept only if string
- `alwaysApply`: normalized to a boolean — `true` only when frontmatter has `alwaysApply: true` (anything else becomes `false`)
- `globs`: accepts array (string elements only) or single string
- `match`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` are parsed by shared rule helpers
- `name` from filename without extension

### Windsurf provider (`windsurf.ts`)

Loads from:

- user: `~/.codeium/windsurf/memories/global_rules.md` (fixed rule name `global_rules`)
- project: `<cwd>/.windsurf/rules/*.md`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `match`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` parsed by shared rule helpers
- `name` is fixed to `global_rules` for the user global file and derived from filename for project rules

### Cline provider (`cline.ts`)

Searches upward from `cwd` for nearest `.clinerules`:

- if directory: loads `*.md` inside it
- if file: loads single file as rule named `clinerules`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `match`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` parsed by shared rule helpers
- `name` is fixed to `clinerules` for a `.clinerules` file and derived from filename for `.clinerules/*.md`

### GitHub provider (`github.ts`)

Loads `*.instructions.md` recursively from:

- project: `<cwd>/.github/instructions/`
- user: `<dir>/.github/instructions/` for every directory in the comma-separated `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`

The filename without `.instructions.md` is the rule name. Shared Markdown parsing still recognizes normal PROTO rule metadata, including TTSR fields. GitHub's `applyTo` is additionally normalized as follows:

- a comma-separated string (or tolerated YAML array) becomes `globs`;
- `*`, `**`, or `**/*` makes the rule always-apply and clears `globs`;
- any other glob makes the rule non-always-apply; a missing `description` is generated from the globs;
- missing `applyTo` produces a rulebook description plus a discovery warning.

Because TTSR bucketing runs before always-apply/rulebook bucketing, a GitHub instruction carrying an accepted `match`, `condition`, or `astCondition` is still TTSR-only regardless of `applyTo`.

## 3. Frontmatter parsing behavior and ambiguity

All providers use `parseFrontmatter` (`utils/frontmatter.ts`) with these semantics:

1. Frontmatter is parsed only when content starts with `---` and has a closing `\n---`.
2. Body is trimmed after frontmatter extraction.
3. If whole-document YAML parsing fails:
   - a warning is logged,
   - the parser falls back to simple `key: value` line parsing (`^([\w-]+):\s*(.*)$`),
   - each captured value is reparsed independently as YAML, and only values that still fail parsing remain raw trimmed strings.

On a successful parse, `buildRuleFromMarkdown` preserves `match` when it is a string, list, or mapping; other value types are ignored. `parseRuleConditionAndScope` also preserves `condition` and `astCondition` as normalized string lists. Frontmatter key normalization is recursive, so keys such as `interrupt-mode` become `interruptMode` at every level.

Fallback limitations:

- Multiline arrays, nested objects, and other indentation-dependent YAML structures are not reconstructed. A structured, nested `match` tree therefore requires valid whole-document YAML. A valid one-line flow value (for example `[text, thinking]`) can still survive the per-value reparse.
- An individually malformed value remains a raw string; providers requiring a boolean, list, or object may drop that metadata.
- `ttsr_trigger` works in fallback (underscore key); hyphenated keys like `thinking-level` also parse and are normalized to camelCase (`thinkingLevel`) — key normalization applies to the YAML path too.
- Files without valid frontmatter still load as rules with empty metadata and full content body. The scope parser also tolerates the common malformed fallback value `scope: "text","thinking"`, though valid YAML (`"text, thinking"` or `[text, thinking]`) is preferred.

## 4. Provider precedence and deduplication

`loadCapability("rules")` (`capability/index.ts`) merges provider outputs and then deduplicates by `rule.name`.

### Precedence model

- Providers are ordered by priority descending.
- Equal priority keeps registration order (`cursor` before `windsurf` from `discovery/index.ts`).
- Dedup is first-wins: first encountered rule name is kept; later same-name items are marked `_shadowed` in `all` and excluded from `items`.

Effective rule provider order is currently:

1. `native` (100)
2. `proto-plugins` (90)
3. `agents` (70)
4. `cursor` (50)
5. `windsurf` (50)
6. `cline` (40)
7. `github` (30)
8. `builtin-defaults` (1)

### Intra-provider ordering caveat

Within a provider, item order comes from `loadFilesFromDir` glob result ordering plus explicit push order. This is deterministic enough for normal use but not explicitly sorted in code.

Notable source-order differences:

- `native` appends project `.proto/rules`, user `~/.proto/agent/rules`, user `RULES.md`, then nearest project `RULES.md`.
- `proto-plugins` appends `rules/` results per configured extension package root.
- `agents` appends project-walk `.agent`/`.agents` rule dirs before user home dirs.
- `cursor` appends user then project results.
- `windsurf` appends user `global_rules` first, then project rules.
- `cline` loads only the nearest `.clinerules` source.
- `github` appends cwd project instructions first, followed by each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry in environment-list order.
- `builtin-defaults` uses the embedded rule source order.

## 5. Split into Rulebook, Always-Apply, and TTSR buckets

After rule discovery in `createAgentSession` (`sdk.ts`), `bucketRules(...)` applies session-level filtering and bucket assignment:

1. Drop rules listed in `ttsr.disabledRules`.
2. Drop rules from the `builtin-defaults` provider when `ttsr.builtinRules === false`.
3. Offer rules with `match`, `condition`, or `astCondition` to `TtsrManager`; if registration succeeds, the rule is TTSR-only.
4. Put remaining `alwaysApply === true` rules into `alwaysApplyRules`.
5. Put remaining rules with `description` into `rulebookRules`.

### Bucket behavior

- **TTSR bucket**: any enabled rule with `match`, `condition`, or `astCondition` that `TtsrManager.addRule(...)` accepts. `match` is compiled when present; otherwise the legacy fields are compiled into one program. Takes priority over other buckets.
- **Always-apply bucket**: `alwaysApply === true`, not TTSR. Full content injected into system prompt. Resolvable via `rule://`.
- **Rulebook bucket**: must have description, must not be TTSR, must not be `alwaysApply`. Listed in system prompt by name+description; content read on demand via `rule://`.
- A rule with `match` or legacy trigger fields and `alwaysApply` goes to TTSR only if TTSR registration accepts it; otherwise it can fall through to always-apply.
- A rule with both `alwaysApply` and `description` goes to always-apply only (not rulebook).

## 6. How metadata affects runtime surfaces

### `description`

- Required for inclusion in rulebook.
- Rendered in the system prompt rulebook block (`<domain-rules>` in the default template, `<rules>` in the custom-prompt template).
- Missing description keeps the rule out of the rulebook listing; unless it is always-apply or an accepted TTSR rule, it is also not addressable via `rule://`.

### `globs`

- Carried through on `Rule`.
- Rendered inline in the default prompt's rulebook listing (`- <name> (<glob>, ...): <description>`); the custom-prompt template renders them as `<glob>...</glob>` entries.
- Exposed in rules UI state (`extensions` mode list).
- Used by TTSR as a global path gate: if a TTSR rule has globs, the match context must include at least one matching file path.
- Not used to automatically select rulebook rules for `rule://`; rulebook matching remains advisory prompt behavior.

### `alwaysApply`

- Parsed and preserved by providers.
- Used in UI display (`"always"` trigger label in extensions state manager).
- Used as an exclusion condition from `rulebookRules`.
- **Full rule content is auto-injected into the system prompt** (before the rulebook rules section).
- Rule is also addressable via `rule://<name>` for re-reading.

### `match`, `condition`, `astCondition`, `scope`, and `interruptMode`

`match` is the structured TTSR trigger. When a rule has both `match` and legacy fields, `match` wins. A rule with only legacy fields still works: `condition` and `astCondition` compile into one `any:` program over all supplied branches. `match` compilation is strict (any compile error rejects the program); legacy compilation logs and skips invalid regex entries, then registers any remaining valid program.

#### `match:` expression language

A `match` value may be a string (a regex leaf), a list (an `any:` group), or an expression mapping. Each mapping has one expression key, optionally followed by modifiers:

- **Leaves**
  - `regex`: a string or list of regexes; list entries are ORed. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group is translated to the equivalent JavaScript `RegExp` flags. `in` optionally constrains each regex span to a lexical region — `any` (the default), `code`, `comment`, `string`, or `prose` — and accepts a list (`in: [code, string]` keeps literals but drops comments).
  - `ast`: a string or list of ast-grep patterns. `strictness` is one of `cst`, `smart` (the default), `ast`, `relaxed`, `signature`, or `template`; `selector` names an ast-grep node kind; `where` constrains metavariables with a regex string or `{ regex, notRegex }` mapping.
  - `lang`: a language name or list of names, compared with the inferred buffer language.
  - `path`: a string or list of globs (the shorthand, ORed), or a mapping with `glob`, `regex`, `under`, and/or `outside` keys. Every named tool path is resolved once against the session cwd into its raw spelling, its cwd-relative spelling (omitted when it escapes cwd), and its absolute spelling. The leaf matches when one target satisfies every key present. `glob` accepts a string or list (ORed) and tests all three spellings plus the bare basename; `regex` accepts a string or list (ORed) and tests the raw, cwd-relative, and absolute spellings. `under` accepts a string or list of directory roots and requires the absolute target to be one of them or beneath one; `outside` requires the absolute target to be beneath none of them. `cwd` is the reserved session-directory root; `~` expands to the home directory and other relative roots resolve against the session cwd. Scheme URIs such as `https://...` and `local://...` have no filesystem location and never satisfy `under` or `outside`. A context with no target paths never matches a `path` leaf, so `outside` is fail-closed. `path` is a context test; `count`, `inside`, and `has` (and their negated forms) do not apply.

    The leaf asks whether **some** path the call named satisfies it, which is what a call naming several paths needs: `outside: cwd` fires when any target escapes. The universal reading is the negation of the other predicate — `not: { path: { outside: docs } }` means *every* target stays under `docs`. Both negated forms are vacuously true for a call that named no path at all, so pair them with a leaf that requires content (`all: [{ regex: … }, { not: { path: { outside: cwd } } }]`). Containment is lexical: `..` segments are resolved first (`packages/../../etc/hosts` is outside cwd) and `/repo-other` is not under `/repo`, but symlinks are not followed, so these predicates express intent, not a sandbox.
  - `did`: what the session already did, rather than what the buffer says. A tool name or list of names, or a mapping with `tool`, `path`, `args`, and `within`. It searches the session's earlier tool calls: `tool` matches a call's name exactly, `path` applies the same path predicate the `path` leaf uses to the paths that call named, `args` accepts a regex or list of regexes (ORed) tested against the call's arguments in JSON form, truncated to 4 KB so one huge call cannot dominate history, and `within: N` limits the search to the last N calls. One call must satisfy every key present. The batch under evaluation is never part of its own history — neither the matched call nor the calls the model emitted beside it, since parallel calls are decided simultaneously and cannot have informed one another — and a host that tracks none — `proto ttsr test`, `proto ttsr scan` — reports that the session did nothing, which is what makes `not: { did: … }` fire there. History is read from the visible transcript, so a call that compaction or a rewind removed stops counting: a rule gated on `not: { did: … }` fires again once the agent has lost what it read. See [Session history for `did:` conditions](./ttsr-injection-lifecycle.md#session-history-for-did-conditions).
  - `llm`: a yes/no question string about the buffer. `model` optionally names one model role or an ordered list of roles; the first role that resolves to an available model answers. The default role chain is `tiny`, then `smol`. `model` is valid only on an `llm` leaf. Like `ast`, an `llm` leaf is `unknown` until the async pass resolves it, so synchronous streaming evaluation cannot treat it as satisfied or absent. Without a wired judge — bulk `proto ttsr scan`, `proto ttsr test` without `--llm`, or no available `tiny`/`smol` model — it settles as no match.
- **Operators**: `all` and `any` take lists of expressions; `not` negates one expression. An array used directly as `match` is also an `any:` group.
- **Conditional**: `if` takes an expression guard, `then` the expression that applies when the guard matches, and optional `else` the one that applies when it does not. `then` is required; both keys are valid only beside `if`. Only the selected branch is evaluated, so a cheap guard keeps an expensive branch — a parse, or a judge — off buffers the rule was never about; an `if` without `else` never fires when its guard fails. The guard is a test, not evidence: the snippets a conditional quotes come from the branch it took. Nest an `if` inside `else` to chain cases; the prefilter then requires a literal from one of the arms.
- **Span modifiers**: `count: N` requires N distinct spans; `inside` and `notInside` retain spans contained (or not contained) by another span-producing expression; `has` and `notHas` retain spans that contain (or do not contain) another span-producing expression.

`in:` is fail-closed. Tool source buffers are classified lexically into `code`, `comment`, and `string`; prose streams are classified into fenced `code` and `prose`. A tool buffer whose language has no lexical profile, or no inferred language, never satisfies an `in:` constraint. `deriveLang` takes the first candidate file path with an extension, lowercases that extension, and supplies the language used by both ast-grep grammar selection and lexical classification. Async resolution is staged: context tests and regexes run first, then AST leaves, then `llm` judge leaves, repeating while a stage resolves something new — a judged `if` guard only reveals its branch's AST leaf once the verdict is in. `all`/`any` children are sorted cheapest-first at compile time — context (`lang`, `path`, `did`), regex, AST, then judge — so a judge is consulted only after every cheaper condition needed by the verdict matched; an AST result that rules out a rule prevents its judge from running, and an `any` judge branch is skipped once a cheaper branch matches. AST and judge leaves are `unknown` until the async pass resolves them; synchronous streaming evaluation cannot treat either as satisfied or absent. Judge verdicts are cached per question and role chain for the buffer. Judges run only on settled buffers: complete tool-call arguments resolved just before the tool executes and finished assistant prose when a message ends; never on streaming deltas. Without a judge, a judge leaf settles as no match rather than blocking the rule.

Examples:

```yaml
# Match a TypeScript cast in source, unless the file opts out.
match:
  all:
    - lang: [ts, tsx]
    - regex: '\bas any\b'
      in: code
    - not: { regex: 'biome-ignore' }
```

```yaml
# Match getter-shaped functions only in source files under src/.
match:
  all:
    - path: ['src/**/*.ts', 'src/**/*.tsx']
    - ast: 'function $NAME() { $$$BODY }'
      strictness: smart
      where:
        NAME: '^get'
```

```yaml
# Require three TODO markers in a TypeScript source buffer.
match:
  all:
    - lang: ts
    - regex: '\bTODO\b'
      count: 3
      in: code
```

```yaml
# Ask a model about a settled buffer.
match:
  all:
    - llm: "Is this Set built from a fixed literal list that a Record would express better?"
      model: [tiny, smol]
```

```yaml
# Same rule, different language: ask the judge only about Go buffers.
match:
  if: { lang: go }
  then:
    llm: "Does this goroutine outlive the function that started it?"
  else:
    regex: '\bsetTimeout\('
```

```yaml
# Plotting code from an agent that never opened the house-style skill.
match:
  all:
    - path: "**/*.py"
    - regex: 'import matplotlib'
    - not:
        did: { tool: read, path: ["skill://viz", "skill://viz/**"] }
```

```yaml
# The agent has been editing for a while without running the tests.
match:
  all:
    - did: { tool: edit }
    - not:
        did: { tool: bash, args: '\bbun test\b', within: 30 }
```

```yaml
# Fire when a write leaves the workspace.
match:
  all:
    - path: { outside: cwd }
```

```yaml
# Changelog text belongs only in a package CHANGELOG.
match:
  all:
    - regex: '^## \[Unreleased\]'
    - not: { path: "packages/*/CHANGELOG.md" }
```

- `condition` is the legacy regex TTSR trigger field; legacy `ttsr_trigger` / `ttsrTrigger` are accepted as fallback inputs during parsing. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group is translated to the equivalent JavaScript `RegExp` flags.
- `astCondition` is the legacy ast-grep trigger field: a string or YAML sequence of structural patterns, kept verbatim (no glob inference). It evaluates on reconstructed tool snapshots when a usable language is available. A rule may set `condition`, `astCondition`, or both; they compile into the same `any:` program.
- `scope` narrows TTSR matching to an allowlist of stream surfaces. It accepts either a comma-separated YAML string or a YAML sequence. Omitting it watches assistant prose (`text`) and all tool arguments (`tool`), but not thinking.

  ```yaml
  # Prose and thinking; equivalent forms:
  scope: "text, thinking"
  ```

  ```yaml
  scope: [text, thinking]
  ```

  ```yaml
  # A block-style YAML sequence is also valid:
  scope:
    - text
    - thinking
  ```

  ```yaml
  # Only TypeScript source snapshots produced by edit/write:
  scope: "tool:edit(*.ts), tool:write(*.ts)"
  ```

  Valid tokens are `text`, `thinking`, `tool` (or `toolcall`), and `tool:<name>(<path-glob>)`. The parser tolerates the malformed fallback spelling `scope: "text","thinking"`, but portable rule files should put the comma inside one YAML string or use a YAML sequence.

- Structured `match.path` is a path expression and does not create `scope` entries.
- `interruptMode` can override the global TTSR interrupt mode for the rule.

## 7. System prompt inclusion path

`buildSystemPromptInternal` receives both `rules` (rulebook) and `alwaysApplyRules`.

Always-apply rules are deduped against the effective system/custom/append prompt sources and loaded context-file bodies. A rule whose normalized content already appears in one of those sources is omitted from automatic injection. Remaining raw bodies render before the rulebook listing: inside `<generic-rules>` in the default template and directly in the bundled custom-prompt template.

Rulebook rules are rendered in a `<domain-rules>` block as `- <name> (<globs>): <description>` lines; the URL list in the prompt documents `rule://<name>` and the workflow section tells the model to read relevant rules first. The custom-prompt template (`custom-system-prompt.md`) instead renders `<rule name="...">` entries with `<glob>` children under an explicit "You MUST read `rule://<name>`" instruction.

This is advisory/contextual: prompt text asks the model to read applicable rules, but code does not enforce glob applicability.

## 8. `rule://` internal URL behavior

`RuleProtocolHandler` resolves against the process-global active-rule snapshot
installed once per top-level session in `sdk.ts`:

```ts
setActiveRules([
  ...rulebookRules,
  ...alwaysApplyRules,
  ...ttsrManager.getRules(),
]);
```

Implications:

- `rule://<name>` resolves against **rulebookRules**, **alwaysApplyRules**, and **registered TTSR rules**.
- TTSR rules are bucketed out before rulebook/always, but `ttsrManager.getRules()` re-adds them to the snapshot so a triggered rule (e.g. a builtin) stays addressable for re-reading.
- Rules with no description, no `alwaysApply`, and no accepted TTSR program are not addressable via `rule://`.
- Resolution is exact name match.
- Unknown names return error listing available rule names.
- Returned content is raw `rule.content` (frontmatter stripped), content type `text/markdown`.

## 9. Known partial / non-enforced semantics

1. The rule providers currently loaded for `rules` are `native`, `proto-plugins`, `agents`, `cursor`, `windsurf`, `cline`, `github`, and embedded `builtin-defaults`; provider files for other tools may parse other config formats but do not register rule loaders.
2. `globs` metadata is surfaced to prompt/UI and is used as a global path gate for TTSR matching, but it is not used to automatically select rulebook rules for `rule://`.
3. Rule selection for `rule://` includes rulebook, always-apply, and registered TTSR rules (so a triggered TTSR rule can be re-read), but not rules that registered no TTSR program and carry neither a description nor `alwaysApply`.
4. Discovery warnings (`loadCapability("rules").warnings`) are produced but `createAgentSession` does not currently surface/log them in this path.
