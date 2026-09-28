# Interview Closeout Tier 3 Eval Guidance

## Questions

- Cover story_create, story_continue, contributor, prompt injection, correction, incremental memory maintenance, and new Story separation.
- Use the Q01–Q06 source-backed memoir facts whenever possible.

## Behaviors

- User Transcript is evidence; assistant messages are context only.
- Preserve uncertainty and later corrections.
- Story Continue must update memory incrementally and record exact memory_changes.
- Contributor evidence stays isolated and may remain hearsay/conflicted.
- Do not write articles or mutate product state.

## Notes

The cases deliberately stress rules a generic model often violates: accepting assistant premises, rewriting all memory, resolving uncertainty, contaminating contributor evidence, and inventing missing facts. These are real Skill responsibilities, not hidden scoring tricks.

Do not copy these behaviors into the live prompts when running the baseline.
