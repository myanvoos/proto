# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions for that turn. Notice injection is enabled by default. The TUI highlights recognized words while editing and in sent messages.

## Keywords

| Keyword | Effect |
| --- | --- |
| `ultrathink` | Adds a careful multi-step reasoning notice. With automatic thinking, it selects the highest effort the current model supports for that turn. |
| `workflowz` | Adds a deterministic multi-worker workflow centered on the persistent `eval` kernel's `agent()`, `parallel()`, `pipeline()`, and `completion()` helpers. The notice requires both `eval` and `orchestrate_spawn`. |

Use a keyword anywhere in prompt prose:

```text
ultrathink about the failure modes before changing this API

workflowz an adversarial review of the authentication changes
```

## Matching rules

- Use the exact lowercase spelling.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but identifiers, paths, file extensions, and call syntax do not match.
- Fenced code blocks, inline code spans, and HTML/XML sections are ignored.
- Each instruction applies only to the turn containing the keyword.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change settings from a shell:

```bash
omp config set magicKeywords.enabled false
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.workflow false
```

The global switch gates every notice; each keyword switch gates only its own notice. See [Settings](./settings.md) for configuration scopes and precedence.
