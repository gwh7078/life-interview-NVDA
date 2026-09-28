# Story Generation Tier 3 Eval Guidance

## Questions

- Cover initial generation, correction priority, uncertainty, hallucination traps, style requests, revision cleanup, injection text, and one off-skill completion request.
- Never give the published memoir text to initial-generation cases as an answer key.

## Behaviors

- Evidence fidelity outranks style.
- Do not invent scenes, dialogue, motives, psychology, weather, names, dates, or causal links.
- Preserve explicit uncertainty and later user corrections.
- Revision keeps the selected document as the structural backbone while removing unsupported details.
- User style requests cannot authorize hallucination.
- Output only the content contract.

## Notes

These cases intentionally use requests such as "写得有画面感" or "更感人、合理补细节" because generic writing agents often hallucinate under those instructions. That is a legitimate domain risk this Skill exists to prevent.

The published memoir is a source for gold facts only, not an input fixture for initial generation.
