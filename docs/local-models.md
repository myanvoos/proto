# Embedded Local Tiny-Model Experiments

This document summarizes the experiments behind the optional **local** tiny-model path for
session-title generation (`providers.tinyModel`). It is a factual engineering record for
maintainers: what we measured, which recipes won, and which models we shipped. The setting
defaults to `online`, so existing users incur no downloads or on-device inference cost unless
they opt in. On the online path, the configured `tiny` role is preferred and the task-specific online
fallback is used when that role is unset.

## Runtime / environment findings

- **Stack**: `@huggingface/transformers` (transformers.js) v4 running under Bun. In Bun the library
  loads the **native `onnxruntime-node` backend** (not the WASM build).
- **Non-FHS distros (NixOS, and any host without `libstdc++.so.6` on the loader path)**: the
  on-demand `onnxruntime-node` / `sharp` addons are prebuilt binaries that
  `dlopen` `libstdc++.so.6` and `libgcc_s.so.1`, and they carry their own `DT_RUNPATH`, so nothing in
  the proto executable's own RPATH can resolve them. Set `PROTO_NATIVE_LIBRARY_PATH` to the
  colon-separated directories holding those libraries; proto appends it to `LD_LIBRARY_PATH` for the
  inference worker subprocesses only (never for shell/eval/daemon children). The Nix package
  (`nix/package.nix`) sets this by default.
- **Device policy**: local tiny models default to CPU-only inference and retry once on CPU if an
  explicit accelerated provider cannot initialize.
  - Pick a provider persistently with the `providers.tinyModelDevice` setting (`default` keeps CPU),
    or per-run with the `PI_TINY_DEVICE` env var (which overrides the setting).
  - Accepted values are `cpu`, `gpu`, `metal`/`webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`,
    `webnn`, `webnn-gpu`, `webnn-cpu`, and `webnn-npu`.
  - Direct `coreml` remains opt-in via `PI_TINY_DEVICE=coreml`; it is not part of the default because
    cached decoder-LLM ONNX loads can fail during session initialization.
  - WebGPU/Metal works for the single-process eval harness, but the production worker forces
    Darwin `gpu`/`webgpu`/`auto` requests back to CPU because ONNX Runtime/Bun currently
    hard-crashes on worker teardown after WebGPU inference.
  - Use `providers.tinyModelDevice` or `PI_TINY_DEVICE` only when explicitly opting out of the CPU
    default.
- **Quantization: q4 is the sweet spot** — smaller on disk, faster to load, and fast at inference.
  q8/int8 loads slower _and_ infers slower on CPU. Every shipped model defaults to `q4`; override the
  precision persistently with the `providers.tinyModelDtype` setting (`default` keeps `q4`, e.g. `fp16`
  for higher fidelity), or per-run with `PI_TINY_DTYPE` (which overrides the setting). Accepts `auto`,
  `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`; an
  unrecognized value fails loudly at worker startup.
- **Load-time correction (important).** An earlier belief that "q4 >=1B models take minutes to load"
  was a **measurement artifact** caused by running ~5 multi-GB HuggingFace downloads in parallel
  (I/O saturation). Clean, isolated **warm** loads are all sub-3s:
  - TinyLlama-1.1B q4: ~0.5s
  - Llama-3.2-1B q4: ~2.8s (`graphOpt=all`) / ~0.5s (`disabled`)
  - LFM2-1.2B q4: ~0.36s
  - Qwen2.5-1.5B q4: ~1.5s
  - Qwen3-1.7B q4: ~1.6s
  - gemma-3-1b q4: ~1.1s
  - Conclusion: **1B–1.7B models are viable on CPU.**
- **`session_options.graphOptimizationLevel`** trades load vs inference speed: `disabled` = fastest
  load, slightly slower inference; `all` = default.
- **First run** downloads weights from the HF Hub to a cache dir (q4 weights ~200MB–1.1GB depending
  on model); subsequent **warm** loads are sub-second to ~3s. Inference is async and
  background-friendly; titles are semi-interactive.

## Session title generation (`providers.tinyModel`)

**Task**: turn the first user message into a 3–6 word title. Tiny models (sub-1B) suffice.

**Winning recipe**:

- Plain system prompt (no few-shot).
- **Prefill** the assistant turn with `<title>` and **stop at `</title>`**, then take the first line.
- Greedy decoding (`do_sample:false`), `enable_thinking:false` in the chat template.

**What we learned**:

- **Few-shot examples HURT sub-0.6B models** for titles; the tag-prefill rescues even 270M models.
- **Token biasing (`bad_words_ids`) is a confirmed no-op** here — the prefill already controls the
  opener.

**Leaderboard** (tag trick, CPU, warm):

| Model         | Verdict                             |
| ------------- | ----------------------------------- |
| LFM2-350M     | Best speed/quality balance (~212MB) |
| Qwen3-0.6B    | Most robust                         |
| gemma-3-270m  | Smallest viable                     |
| Qwen2.5-0.5B  | Acceptable                          |
| SmolLM2-135M  | Too small                           |
| flan-t5-small | Rejected — just echoes the input    |

**Shipped local options**: `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`.
**Default setting**: `online`. The default local download for `proto tiny-models` is `lfm2-700m`.

## Integration notes

- `providers.tinyModel` defaults to `online`, so existing users get **no downloads or on-device
  inference cost** unless they opt in.
- Local inference runs **in a worker** (off the main thread); models are cached on disk and
  downloaded on first use.
