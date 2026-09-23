# @oh-my-pi/pi-catalog

Model catalog for proto: bundled model database, provider discovery, model identity, classification, and equivalence.

## What's inside

| Module                          | Purpose                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `models/*.json`                  | Bundled per-provider model database (pricing, context windows, modalities, thinking support)                |
| `provider-models`               | Provider catalog descriptors (`CATALOG_PROVIDERS`), per-provider model resolution rules                     |
| `discovery`                     | Runtime model discovery for OpenAI-compatible endpoints, Gemini, Codex, Cursor, Antigravity, Ollama         |
| `identity`                      | Model id parsing and classification (family/version), reference resolution, equivalence, selection priority |
| `model-thinking`                | Thinking/reasoning metadata and generated per-model policies                                                |
| `model-manager` / `model-cache` | Runtime model registry with discovery refresh and on-disk caching                                           |
| `variant-collapse`              | Collapsing provider-specific variants of the same underlying model                                          |
| `compat`                        | Request/response compatibility fixups for OpenAI- and Anthropic-shaped APIs                                 |
| `wire`                          | Wire-level helpers: Codex, Gemini headers, GitHub Copilot                                                   |
| `effort`                        | Reasoning-effort level definitions                                                                          |

Import from subpaths (`@oh-my-pi/pi-catalog/<module>`) or the root barrel.

## models/ is generated

Never edit `src/models/*.json` by hand — they are produced from upstream sources (stencil.so, the Pi Codex catalog, provider catalog discovery, OpenCode docs) by `scripts/generate-models.ts` and the resolvers in `src/provider-models/`. Regenerate with:

```sh
bun run gen:models
```

To change an entry, fix the source: resolver overrides in `provider-models/openai-compat.ts`, provider entries in `provider-models/descriptors.ts`, generator fixups in `scripts/generate-models.ts`, or thinking policies in `model-thinking.ts`.

## Cost calculation

The `models` subpath (also exported from the root) provides timestamp-aware pricing helpers:

| API                                                               | Result                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `calculateCost(model, usage, timestamp?)`                         | Updates and returns `usage.cost` using `model.cost`.                                                      |
| `calculateUsageCost(cost, usage, timestamp?)`                     | Updates and returns `usage.cost` using a `ModelCost`.                                                     |
| `calculateUncachedInputCost(cost, promptInputTokens, timestamp?)` | Returns the cost of a fully uncached prompt.                                                              |
| `getTimeBasedPricingPeriod(cost, timestamp?)`                     | Returns `"peak"`, `"off-peak"`, or `undefined` without a schedule.                                        |
| `getNextTimeBasedPricingTransition(cost, timestamp?)`             | Returns the next actual peak/off-peak change strictly after the timestamp, or `undefined` if none exists. |

Timestamps are Unix milliseconds; omitted timestamps use the current time for scheduled pricing. Flat token prices are unaffected. Pricing selects the latest applicable effective rate card, then its long-context tier, then the peak/off-peak multiplier. A transition query concerns the recurring tariff, not dated rate-card changes.

`ModelCost.timeBased` is optional typed metadata (`TimeBasedCost`): `offPeakMultiplier`, `peakWindows` (UTC `weekdays`, Sunday = 0, and start-inclusive/end-exclusive `startMinute`/`endMinute`), and optional `effectiveRates`. Each effective rate is a complete `TokenCost` with an `effectiveFrom` Unix-millisecond timestamp and optional `longContext` tier, replacing the base card from that instant.

Pass the request-start timestamp when estimating request usage, then preserve the resulting monetary amounts rather than repricing history at display time. proto does this using the assistant message timestamp; it is an estimation convention, not a claim about server billing across boundaries. Prefer monetary costs reported by a provider when available.

Schedules are generated catalog metadata (`scripts/generated-policies.ts`); the coding agent's `models.yml` has no `timeBased` input. See [user-facing pricing behavior](../../docs/models.md#usage-costs-and-time-based-pricing) for DeepSeek rates, dates, and footer indicators.

## Install

```sh
bun add @oh-my-pi/pi-catalog
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [CHANGELOG](./CHANGELOG.md)
