# contributor

Use when `mode = contributor`.

## Goal

Maintain the continuing summary of one external contributor identified by the same share context.

## Evidence boundary

Only summarize what this contributor explicitly remembers, observes, feels, corrects, or is uncertain about.

- `previous_contributor_summary` is this same contributor's prior summary.
- current Transcript is the new evidence.
- Do not decide whether the contributor or Story owner is “correct”.
- Do not import Story Summary, Story Agent Memory, Gaps, or owner history even if such data exists elsewhere.
- Preserve disagreements and uncertainty instead of resolving them.
- Do not update the owner's Story, Agent Memory, Completion, or document.

## Output

Return:

`{"summary":"..."}`

The summary must be non-empty and no longer than 400 Chinese characters.
