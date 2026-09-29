# Story Completion Tier 3 Eval Guidance

## Questions

- Use enough/insufficient Story Memory, answered gaps, blocked directions, low-value unknowns, complete-state retention, scope leakage, and injection text.
- Do not provide Transcript: production story.completion intentionally works from Story Memory unless the Skill explicitly performs bounded Evidence Search.

## Behaviors

- Treat the Story title as the primary scope boundary; Life Stage and broader Memory do not expand the current Story automatically.
- Judge whether the title-defined Story can support a coherent standalone article without invention.
- Distinguish blocking gaps from optional enrichment and separate adjacent Stories.
- Re-evaluate old gaps; delete questions that are answered, blocked, out of scope, or merely nice-to-have.
- Prefer 0–3 high-value blocking gaps over exhaustive fact collection.
- Keep complete stories complete.
- Never write the article or rewrite memory.

## Scope regression

Required regression:

- Story title: `高考志愿填报`
- Memory may also mention later university life and post-graduation employment.
- Completion must not ask about university classroom impressions or first-job search merely because they appear in Memory.
- If the choice/decision/result needed for `高考志愿填报` is already sufficient, return `complete` with no out-of-scope gap.

## Notes

The strongest lift should come from cases where generic assistants tend to keep asking every unknown detail, let Life Stage broaden the Story boundary, ignore blocked directions, or fail to delete answered gaps.
