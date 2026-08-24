# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its default target is the model assigned to the `@smol` role.

## Enable prewalk

Enable prewalk persistently in the global config:

```bash
proto config set prewalk.enabled true
```

The equivalent YAML in `~/.proto/agent/config.yml` or a project `.proto/config.yml` is:

```yaml
prewalk:
  enabled: true
```

Session flags override the configured value:

| Flag | Effect |
| --- | --- |
| `--prewalk` | Arm prewalk for the new session. |
| `--no-prewalk` | Leave prewalk disabled for the session, even when `prewalk.enabled` is `true`. |
| `--prewalk-into <model-or-role>` | Arm prewalk and use the supplied model pattern or role instead of `@smol`. |

For example:

```bash
proto --prewalk
proto --prewalk-into @smol
proto --prewalk-into openai/gpt-5-mini
```

At startup, PROTO resolves the target with the normal model-role and model-matching rules. If the target cannot be resolved or has no configured credentials, PROTO prints a warning and starts with prewalk unarmed.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. PROTO then switches models after the first completed `edit` or `write` call.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The switch is one-shot: after the handoff, prewalk disarms itself. The target model and thinking level are not changed when they already match the active session, because that handoff would be a no-op.

## Arm from an active session

Run the slash command to arm prewalk without restarting PROTO or enabling it in config:

```text
/prewalk
```

`/prewalk` always targets the `@smol` role. If prewalk is already armed, the command leaves the existing target in place. After a handoff is consumed, switch to another model and run `/prewalk` again to arm another one-shot handoff. To choose a different target at startup, use `--prewalk-into`.

## Subagent prewalk

Workers have separate prewalk controls: agent frontmatter, `orchestrator.prewalk`, and per-agent `orchestrator.agentPrewalk` overrides. See [Worker agent discovery](./worker-agent-discovery.md) for their precedence and target selection.
