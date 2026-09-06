# CLI reference

`proto` is invoked as:

```sh
proto [command] [flags] [messages...]
```

When the first non-flag argument is **not** a registered subcommand, `proto`
routes to the default [`launch`](#launch-the-default-command) command and treats
the arguments as the initial prompt. So `proto "fix the build"` launches a session
with that message, while `proto models` runs the `models` subcommand.

Runtime help is also available:

- `proto --help` lists user-facing subcommands and common launch flags.
- `proto <command> --help` prints that command's public flags and examples.

This page is the consolidated reference for the shared **launch surface** (the
flags accepted by `proto` / `proto launch`) and every top-level **subcommand**.
Per-subcommand flags (for example `proto auth-broker --json`) are documented by
each command's `--help`.

## Launch (the default command)

`proto` and `proto launch` start a coding session. Positional arguments become the
initial message(s):

```sh
# Interactive session
proto

# Interactive session with an initial prompt
proto "List all .ts files in src/"

# Attach files/images to the initial message (prefix with @)
proto @prompt.md @image.png "What color is the sky?"

# Non-interactive: process the prompt and exit (headless / print mode)
proto -p "List all .ts files in src/"

# Continue the previous session
proto --continue "What did we discuss?"
```

Argument handling:

- `@<path>` attaches a file or image to the initial message.
- Non-TTY stdin is read automatically as the initial prompt; do not add a `-`
  marker.
- `--` ends flag parsing; everything after it is literal message text, even if it
  looks like a flag.

### Launch flags

#### Session and workspace

| Flag | Description |
| --- | --- |
| `--cwd <dir>` | Directory to start in (overrides the launch cwd). |
| `--add-dir <dir>` | Add a workspace directory beyond the working directory (repeatable). |
| `--allow-home` | Allow starting in `~` without auto-switching to a temp dir. |
| `--profile <name>` | Use an isolated profile for auth, sessions, settings, and caches. |
| `--alias <name>` | Create a shell shortcut for the selected profile and exit. |
| `--config <file>` | Load an extra `config.yml`-style overlay for this run (repeatable). |
| `--session-dir <dir>` | Directory for session storage and lookup. |
| `--no-session` | Don't save the session (ephemeral). |

#### Session history

| Flag | Description |
| --- | --- |
| `--continue`, `-c` | Continue the previous session. |
| `--resume [id]`, `-r`, `--session [id]` | Resume a session by ID prefix or path, or open the picker when no value is given. |
| `--fork <session>` | Fork a saved session (by ID prefix or path) into a new session. See [session operations](./session-operations.md). |
| `--from-claude` | Import a Claude Code session into PROTO. |
| `--from-codex` | Import a Codex session into PROTO. |
| `--no-title` | Disable title auto-generation (equivalent to the `PI_NO_TITLE` [environment variable](./environment-variables.md)). |

#### Model selection

| Flag | Description |
| --- | --- |
| `--model <id-or-role>` | Model or configured role to use (role: `slow` or `@slow`; fuzzy model match: `opus`, `gpt-5.2`, or `openai/gpt-5.2`). |
| `--smol <id>` | Smol/fast model for lightweight tasks (or `PI_SMOL_MODEL`). |
| `--slow <id>` | Slow/reasoning model for thorough analysis (or `PI_SLOW_MODEL`). |
| `--models <a,b,c>` | Comma-separated model patterns for `Ctrl+P` cycling. |
| `--provider <name>` | Provider to use (legacy; prefer `--model`). |
| `--api-key <key>` | API key (defaults to env vars). |
| `--provider-session-id <id>` | Reuse a specific provider-side session id for continuity and cache scoping. |
| `--prompt-cache-key <key>` | Override the provider prompt-cache key for this session. |
| `--service-tier <tier>` | OpenAI service tier for this session (`none` omits `service_tier`). |

See [providers](./providers.md) and [models](./models.md) for model resolution.

#### Thinking and reasoning

| Flag | Description |
| --- | --- |
| `--thinking <level>` | Set the thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `auto`. |
| `--hide-thinking` | Hide thinking blocks in TUI output (display only; does not disable model thinking). |
| `--print-thoughts` | Include thinking blocks in print-mode text output. |
| `--external-thinking` | Use a private scratchpad while disabling supported GPT/Claude/Gemini reasoning. Use at your own risk: providers have flagged this request shape as abuse. |

#### Prewalk

| Flag | Description |
| --- | --- |
| `--prewalk` | Switch to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see `prewalk.enabled`). |
| `--no-prewalk` | Disable prewalk even if `prewalk.enabled` is set. |
| `--prewalk-into <id>` | Target model for prewalk (default the `smol` role). |

#### Tools and runtime

| Flag | Description |
| --- | --- |
| `--tools <a,b,c>` | Comma-separated list of tools to enable (default: all). |
| `--no-tools` | Disable all built-in tools. |
| `--no-pty` | Disable PTY-based interactive bash execution. |
| `--advisor` | Enable the advisor runtime (passively reviews each turn and injects notes). See [advisor / watchdog](./advisor-watchdog.md). |
| `--max-time <duration>` | Stop the session after this duration (e.g. `600`, `10m`, `1h`). |

#### Extensions, hooks, skills, and rules

| Flag | Description |
| --- | --- |
| `--extension <path>`, `-e <path>` | Load an extension (repeatable). See [extensions](./extensions.md). |
| `--hook <path>` | Load a hook/extension file (repeatable). See [hooks](./hooks.md). |
| `--trusted-extension <abs-path>` | Load a trusted extension from an absolute path (repeatable; cannot be combined with `--extension`/`-e`/`--hook`). |
| `--plugin-dir <dir>` | Add a local plugin directory to discovery (repeatable). |
| `--no-extensions` | Disable extension discovery (explicit `-e` paths still work). |
| `--skills <globs>` | Comma-separated glob patterns to filter [skills](./skills.md) (e.g. `git-*,docker`). |
| `--no-skills` | Disable skills discovery and loading. |
| `--no-rules` | Disable rules discovery and loading. See [context files](./context-files.md). |

#### System prompt

| Flag | Description |
| --- | --- |
| `--system-prompt <text\|file>` | System prompt (default: coding assistant prompt). See [system prompt customization](./system-prompt-customization.md). |
| `--append-system-prompt <text\|file>` | Append text or file contents to the system prompt. |

#### Output mode

| Flag | Description |
| --- | --- |
| `--mode <mode>` | Output/transport mode: `text` (default), `json`, `rpc`, `acp`, or `rpc-ui`. See [output modes](#output-modes---mode). |

#### Information

| Flag | Description |
| --- | --- |
| `--help`, `-h` | Show help for `proto` or a subcommand and exit. |
| `--version`, `-v` | Print the installed version and exit. |

### Headless / print mode

`--print` / `-p` runs `proto` non-interactively: it processes the prompt, streams
the result to stdout, and exits without entering the TUI. This is the entry point
for scripting and automation.

```sh
# Print the answer and exit
proto -p "Summarize the changes in the last commit"

# Include the model's thinking blocks in the printed text
proto -p --print-thoughts "Explain your reasoning for this refactor"

# Machine-readable output for pipelines
proto -p --mode json "List every TODO in src/" > todos.json

# Pipe a prompt via stdin
echo "review this diff" | proto -p
```

Related flags for headless runs:

- `--print-thoughts` — include thinking blocks in the printed text output.
- `--mode json` — emit structured events instead of rendered text.
- `--no-title` — skip title auto-generation (also `PI_NO_TITLE`).
- `--max-time <duration>` — bound the run.

The [advisor / watchdog](./advisor-watchdog.md#headless-runs) doc describes
print-mode disposal semantics when the advisor runtime is enabled.

### Output modes (`--mode`)

| Mode | Description |
| --- | --- |
| `text` | Default. Rendered text output (TUI when interactive, plain text under `--print`). |
| `json` | Structured JSON event stream, for headless/machine consumption. |
| `rpc` | JSON-RPC server over stdio. See [RPC](./rpc.md). |
| `rpc-ui` | RPC transport with UI extension events enabled. |
| `acp` | Agent Client Protocol server over stdio. Equivalent to the [`acp`](#subcommands) subcommand. |

## Subcommands

Run `proto <command> --help` for each command's own flags and examples.

| Command | Purpose | See also |
| --- | --- | --- |
| `launch` | Start a coding session (the default command). | [Launch flags](#launch-flags) |
| `acp` | Run Proto as an ACP (Agent Client Protocol) server over stdio. | |
| `auth-broker` | Manage the proto auth-broker (credential vault). | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | Run an auth-gateway forward proxy backed by the configured broker. | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | Manage bundled worker agents. | [worker agent discovery](./worker-agent-discovery.md) |
| `bench` | Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s). | |
| `browser-relay` | Run the local CDP relay that lets the browser tool drive your own Chrome tabs. | [computer use](./computer-use.md) |
| `commit` | Generate a commit message and update changelogs. | |
| `completions` | Print a shell completion script (bash, zsh, or fish). | |
| `compress` | Rewrite a text file into the dense prompt register, reporting what it drops. | |
| `config` | Manage configuration settings. | [config usage](./config-usage.md), [settings](./settings.md) |
| `dry-balance` | Dry-run OAuth account balancing across random session ids. | |
| `gc` | Run storage garbage collection. | |
| `grep` | Search files with the native grep engine. | |
| `gallery` | Preview tool renderers across streaming, in-progress, success, and failure states. | |
| `grievances` | View, clean, or push reported tool issues (auto-QA grievances). | |
| `install` | Install or link an extension package (alias of `plugin install` / `plugin link`). | [extensions](./extensions.md) |
| `models` | List, search, and refresh available models. | [models](./models.md) |
| `plugin` | Manage plugins (install, uninstall, list, etc.). | [extensions](./extensions.md), [marketplace](./marketplace.md) |
| `ps` | List and control daemon-supervised background processes (logs, stop, kill, restart). | |
| `setup` | Run onboarding setup or install dependencies for optional features. | |
| `shell` | Interactive shell console. | |
| `read` | Show what the read tool will return for a path, URL, or internal URI. (The [`read` tool](./tools/read.md) is a separate agent tool.) | |
| `ssh` | Manage SSH host configurations. | |
| `stats` | View usage statistics. | |
| `update` | Check for and install updates. | |
| `usage` | Show provider usage limits for every authenticated account. | |
| `tiny-models` | Download tiny local models (session titles + memory). | [local models](./local-models.md) |
| `token` | Get the API key or OAuth token for a provider. | [secrets](./secrets.md) |
| `ttsr` | Inspect and test Time-Traveling Stream Rules (TTSR). (Covers the CLI command; the [TTSR feature](./ttsr-injection-lifecycle.md) is documented separately.) | |
| `worktree`, `wt` | List or clear agent-managed git worktrees (`~/.proto/wt`). | |
| `search`, `q` | Test web search providers from the CLI. | [web_search tool](./tools/web_search.md) |

> `install`, `browser-relay`, `auth-gateway`, and `tiny-models` are also
> reachable through related mechanisms (the `plugin` command and so on).
> The table lists each as it is registered in
> `packages/coding-agent/src/cli-commands.ts`.

### Supervised process logs and shutdown

`fleet` log requests with a returned `cursor` read only newer output; omitting the cursor reads retained history. A follow timeout does not replay previous output. The broker retains bounded log windows across rotation and uses the current process generation for historical pattern waits.

During broker shutdown, new launches are rejected with a retryable shutdown error instead of being reported as running immediately before termination. Retry after the departing broker exits; concurrent clients continue to use the shared project broker.
