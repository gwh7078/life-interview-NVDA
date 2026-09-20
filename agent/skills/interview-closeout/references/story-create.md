# story_create

Use when `mode = story_create`.

## Goal

Create exactly one Story proposal from the ended interview.

## Context

You may receive:

- target Life Stage
- optional `target_story_title`
- other Story summaries for duplicate awareness
- current Transcript

## Rules

- If `target_story_title` exists, preserve it exactly.
- Otherwise choose a clear, restrained title supported by the interview.
- `summary` is a concise user-facing story skeleton, not a Transcript recap.
- `agent_memory` is long-term working memory for future interviews. Capture known facts, people, relationships, sequence, concrete details, feelings/motivations, corrections, uncertainty, and exhausted directions when present.
- Do not write Agent Memory as Q/A.
- `source_message_ids` must directly support the proposed Story.
- Do not split other experiences into additional Story seeds in this mode.
- Do not use `other_stories` as evidence. They are duplicate/context hints only.

Return only the registered `story_create` schema.
