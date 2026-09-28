# Interview Observer Tier 3 Eval Guidance

## Questions

- Test evidence selection, conflict detection, irrelevance filtering, answer-vs-question evidence boundaries, injection resistance, and unknown facts.
- Keep inputs within the production contract: one query and at most five Q+A evidence items.

## Behaviors

- Question text is context only; Answer text is the factual candidate.
- Select only evidence relevant to the current query.
- Do not retrieve, infer, or invent missing facts.
- Keep output bounded and concise.
- Empty/unknown outcomes are valid.

## Notes

These cases are intentionally hard for a generic assistant because a generic model tends to over-select evidence, trust question premises, or fill unknowns. The with-skill arm should improve those behaviors without receiving extra facts.
