{{baseDescription}}

Code Mode active: this tool is your primary work surface; the direct tool surface is restricted. Batch known next steps into ONE cell via `await tool.<name>(args)` / `parallel([…])`; separate cells when a step must inspect an earlier result. Prefer `tool.*` over raw `Bun.file`/fs.

exec tool declarations:
```ts
declare const tool: {
{{declarations}}
};
```
