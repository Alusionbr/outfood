# Codex agent policy

## Goal
Keep implementation quality high while minimizing unnecessary context and GPT-6 Astra usage.

## Repository-specific context discipline
- This project currently contains very large single-file HTML artifacts. Do not read the full file by default.
- Start with targeted search for the UI section, function, event handler, CSS selector, or text involved in the task.
- Fetch only the relevant ranges around search hits. Expand incrementally when dependencies are discovered.
- Avoid opening both duplicate/near-duplicate HTML files unless comparison is necessary.
- Reuse a concise summary of unchanged sections instead of reopening them.

## Model routing
When selectable subagents/models are available:
- **GPT-6 Astra**: architecture, major restructuring, hard state/data-flow bugs, security-sensitive changes, and final review of broad/high-risk work.
- **GPT-5.6 Sol**: default implementation, refactors, normal debugging, and review.
- **GPT-5.6 Terra**: well-scoped implementation with clear requirements.
- **GPT-5.6 Luna**: targeted repository search, repetitive edits, formatting, small isolated fixes, and narrow verification.
- Do not use Astra to scan giant HTML files, locate selectors/functions, or make mechanical edits.
- If model-selectable subagents are unavailable, follow the staged workflow without claiming delegation occurred.

## Workflow
1. Identify the exact screen/behavior to change.
2. Search for the relevant identifiers/text first.
3. Read only the surrounding ranges needed to understand dependencies.
4. Make a concise plan for non-trivial changes.
5. Implement with the least expensive reliable model.
6. Verify the affected interaction and inspect the final diff.
7. Escalate to Astra only for unresolved complexity or high-risk final review.

## Quality gate
- Preserve existing behavior outside the requested scope.
- Do not weaken validation, error handling, security, or persistence logic to reduce token use.
- Avoid unrelated formatting churn in large files.
- Prefer focused, reviewable diffs.
- Stop rereading unchanged sections or repeating broad checks once targeted verification passes and no unresolved risk remains.
