# Why proto

---

If you've been following the development of agent harnesses over the last year, you might've noticed that they point in the same direction.

First, the industry converged on code as the tool-calling substrate. Second, the labs started training models against specific harnesses that increasingly converge to bash + a few specialised tools.

## Why are we converging on code?

In October 2025, Alex Zhang published [Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/): instead of stuffing a long input into the context window, offload it into a Python REPL as a variable, and let the model write code to grep it, chunk it, and call sub-LLMs over it. 

You can see the pattern in a few other places:

- Anthropic shipped [Programmatic Tool Calling](https://www.anthropic.com/engineering/advanced-tool-use) (Nov 2025) and [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp). These are tools invoked from Python in a sandbox, which resulted in 98.7% fewer tool-definition tokens.
- Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) (Sep 2025) wrapped MCP servers into a typed TypeScript API executed in a V8 isolate.
- OpenAI shipped PTC in the Responses API with GPT-5.6 (Jul 2026) [enabled by default](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) in their hosted agent harness.
- Earendil's pi added [codemode](https://earendil.com/posts/you-said-no-mcp/) in v0.99.0 (Sep 2026). Codemode consists of model-written JavaScript in a QuickJS sandbox, composing MCP tools, with large outputs kept out of context.
- Prime Intellect built [Prime Agent](https://primeintellect.ai/blog/prime-agent) (Aug 2026), where the *only* tool is a persistent IPython kernel where file operations, sub-agents, and context management all happen as code.
- Meta FAIR's [Context Language Models](https://github.com/facebookresearch/context-language-models) (Sep 2026) made the model's live context itself a file it can edit with Bash.

The conclusions that everyone has converged on after a year of independent work appear to be:

- That models write code better than they do native tool calls (which is basically akin to filling in JSON schemas).
- That intermediate results should stay in program variables instead of round-tripping through the context.
- That control flow belongs in code (Claude Code's [dynamic workflows](https://code.claude.com/docs/en/workflows)!)
- That frontier models, increasingly, really like editing files using Python! As Armin Ronacher (pi's co-creator) put in a [comment on the "You said no MCP" thread](https://news.ycombinator.com/item?id=49906637): "the models by the labs are increasingly trained on [codemode]. Codex for instance in responses lite requires codemode to even perform parallel tool calling."
- That the labs run RL inside their own harnesses, so the models develop harness-specific priors, and third-party harnesses inherit those priors whether they like them or not (like Prime Intellect's ["model-harness co-learning is the dominant paradigm"](https://primeintellect.ai/blog/prime-agent))


## So why `proto`?

The core idea is that `proto` attempts to combine all the above into a single harness.

If the labs are RL-training models against their own harnesses, then a third-party harness has two options: either mimic the shapes the models were trained on, or provide surfaces so general that any prior works on them. To me, that means a real shell, persistent kernels, code as the composition layer, and stable orchestration primitives. 

After all, they're very likely to be the surfaces the next generation of models will most plausibly be trained against.
