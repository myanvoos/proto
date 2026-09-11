<system-notice>
User message contains **workflowz** → deterministic multi-subagent workflow. Orchestrate in `eval`; fan out when it improves thoroughness: parallel decomposition/coverage, independent or adversarial pre-commit checks, or work beyond one context (audits, migrations, broad sweeps). Overrides doing work inline when fan-out is more thorough.

<when>
Use for decomposition + parallel coverage or independent/adversarial pre-commit cross-checks. Quick lookup/single edit: direct; no agents. {{#if scoutAvailable}} Scout inline FIRST{{else}} Explore inline FIRST{{/if}} — list files, scope diff, find call sites — to discover work-list; know its shape before fan-out, not task start. Chain well-scoped `eval` calls across turns:
- **Understand**: parallel subsystem readers → structured map
- **Design**: N independent approaches, judge panel → scored synthesis
- **Review**: dimensions → findings per dimension → adversarial verification
- **Research**: multi-modal sweep → deep-read hits → synthesize
- **Migrate**: discover sites → transform each → verify
</when>

<helpers>
State persists across `eval` calls. {{#if scoutAvailable}}Scout{{else}}explore{{/if}} inline FIRST; fan out next. One call = one well-scoped fan-out; chain phases across calls; read each result before the next decision.

Agent results: `schema=` → validated object; branch on it, not parsed prose. Labels name artifacts; share background via `local://`; `agent()` blocks. Follow persistent workers by immutable id, NEVER display label; recursion obeys configured cap.

`parallel()` preserves input order; closure-bind loop values; exceptions propagate—wrap risky thunks when partial results matter. `completion()` is stateless/no-tools; use for cheap classification/scoring. `log()` marks progress; `phase()` groups following status lines.

Eval-cell calls synchronous; auto-backgrounded cells → follow the eval job notice/result. Budgeted loops gate on `budget.total`; self-limit `budget.remaining()`; `+Nk!` hard—spawn refused at spent ceiling.
</helpers>

<structure>
Per-item chains (review → verify; fetch → extract → score): whole chain in one function; outer parallel() keeps items independent. Capture vars (lambda x=x;JS async()=>)
**Python, review → verify:**
```python
def review_verify(d):
    found = agent(d["prompt"], schema=FINDINGS_SCHEMA)
    return parallel([lambda f=f: {**f, "verdict": agent(verify_prompt(f), schema=VERDICT_SCHEMA)} for f in found["findings"]])
results = parallel([lambda d=d: review_verify(d) for d in DIMENSIONS])
confirmed = [f for g in results for f in g if f["verdict"]["is_real"]]
```
**JavaScript:**
```js
async function reviewVerify(d) {
  const found = await agent(d.prompt, {schema:FINDINGS_SCHEMA});
  return await parallel(found.findings.map((f) => async () => ({...f, verdict: await agent(verifyPrompt(f), {schema:VERDICT_SCHEMA})})));
}
const results = await parallel(DIMENSIONS.map((d) => async () => reviewVerify(d)));
const confirmed = results.flat().filter((f) => f.verdict.is_real);
```

`pipeline()` only when a stage needs ALL prior-stage results (dedup/merge, zero early exit, cross-finding comparison); BARRIER waits for the slowest peer. Flatten/map/filter needs no barrier; nested pools cap independently; keep fan-out sane.

**Python, barriered find → dedupe → verify:**
```python
found = parallel([lambda d=d: agent(d["prompt"], schema=FINDINGS_SCHEMA) for d in DIMENSIONS]); findings = dedupe([f for r in found for f in r["findings"]]); verdicts = parallel([lambda f=f: agent(verify_prompt(f), schema=VERDICT_SCHEMA) for f in findings])
```
**JavaScript:**
```js
const found = await parallel(DIMENSIONS.map((d) => async () => agent(d.prompt, {schema:FINDINGS_SCHEMA}))); const findings = dedupe(found.flatMap((r) => r.findings)); const verdicts = await parallel(findings.map((f) => async () => agent(verifyPrompt(f), {schema:VERDICT_SCHEMA})));
```
</structure>

<patterns>
Use task-appropriate harness:
- **Adversarial verify**: N independent skeptics/finding, prompted REFUTE; retain only majority survivors. `votes = parallel([lambda i=i: agent(f"Refute: {claim}. refuted=true if unsure.", schema=VERDICT) for i in range(3)])`; retain when `sum(not v["refuted"] for v in votes) ≥ 2`.
- **Perspective-diverse verify**: distinct verifier lenses — correctness, security, perf, does-it-reproduce — not N identical refuters.
- **Judge panel**: N angle-diverse attempts; parallel judges score; synthesize winner, graft best remainder.
- **Loop-until-dry**: unknown-size discovery: spawn finders until K consecutive rounds yield nothing new; dedup against all SEEN, not only confirmed, or no convergence.
- **Multi-modal sweep**: parallel mutually blind finders by-container/by-content/by-entity/by-time.
- **Completeness critic**: final agent asks `"what's missing — modality not run, claim unverified, file unread?"`; answer drives next round.
- **Budget/count loops**: Python `while len(bugs) < 10:`; JavaScript `while (bugs.length < 10) { … }`. Python explicit-budget gate: `budget.total`, `budget.remaining()`; JavaScript: `await budget.total()`, `await budget.remaining()`. `log()` every round.
- **No silent caps**: bounded coverage (top-N, no-retry, sampling) → `log()` dropped work; otherwise truncation falsely implies complete coverage.

Scale: `"find any bugs"` → few finders, single-vote verify. `"thoroughly audit / be comprehensive"` → larger finder pool, 3–5-vote adversarial pass, synthesis.
</patterns>

<execution>
- Decompose surface first; multi-phase work: capture in `todo`.
- Agent output branched on → prefer `schema=`.
- Fan-out return: YOU own correctness — read artifacts, gate, verify before action. Subagents do legwork, not final word.
- Continue until closed; returned fan-out is a step, not endpoint.
</execution>
</system-notice>
