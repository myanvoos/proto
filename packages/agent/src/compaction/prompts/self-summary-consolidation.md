<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID mean MUST NOT and SHOULD NOT respectively.
</system-conventions>

<critical>
Consolidate the self-memory entries above into one replacement memory. This is the explicit safety consolidation, not the normal append-only update.
MUST retain usable knowledge from the entire memory, including the oldest entries. Output ONLY the replacement body, without preamble, commentary, or XML wrappers.
</critical>

The self-memory chain has reached 30% of the model's context window. Up to {{maxTokens}} output tokens are available for a smaller replacement; prioritize preserving understanding over achieving the shortest summary.

- Merge duplicates and overlapping explanations without discarding distinct details.
- Apply explicit corrections and state updates; retain the evidence and rationale that still matter.
- Preserve concrete learned techniques, source-specific distinctions, exceptions, representative examples, cross-source conclusions, operative constraints, and unresolved work.
- Keep original source paths and exact identifiers where they support precision; NEVER replace substantive lessons with a reading list or recall pointers.
- Remove repeated activity logs, obsolete status, and boilerplate before sacrificing learned content.
- Distinguish verified findings, interpretation, and remaining uncertainty. NEVER invent missing evidence or completed work.
- Organize by subject for retrieval. First person refers to you.

<critical>
This output replaces all earlier self-memory entries. MUST preserve still-useful knowledge across the whole chain, not just recent activity. NEVER return a status paragraph in place of accumulated learning.
</critical>
