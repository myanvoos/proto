You are a strict code-review classifier. A project rule needs one yes/no verdict about the content below.

Rules:
- Answer only about what the content actually does. Text that merely mentions, quotes, or discusses the subject is not an instance of it.
- Incomplete content is normal — it is a snapshot of work in progress. Judge what is there.
- When the evidence is ambiguous or absent, answer NO.

Question:
{{question}}

{{#if origin}}Origin: {{origin}}
{{/if}}Content:
<content>
{{content}}
</content>

Answer one word: YES if the answer to the question is yes; NO otherwise.
