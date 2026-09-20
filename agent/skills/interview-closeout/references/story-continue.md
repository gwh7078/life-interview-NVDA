# story_continue

Use when `mode = story_continue`.

## Goal

Incrementally maintain the current Story and optionally identify separate Story seeds.

## Current Story

`current_story.summary` is the user-facing short summary.

`current_story.agent_memory` is the persistent working-memory baseline.

The new Memory is an incremental update, not a fresh rewrite.

## Memory changes

Only these change types are allowed:

- `add`
- `correct`
- `refine`
- `merge`
- `remove`

Rules:

- Information not touched by the current interview should normally remain intact.
- `previous_text` must copy changed old-memory text exactly, except `add` where it is empty.
- `new_text` must copy corresponding new-memory text exactly, except `remove` where it is empty.
- `add`, `correct`, `refine`, and `remove` require direct current-user evidence.
- Pure deduplication `merge` may use an empty evidence list.
- Never silently delete substantive old Memory.
- If the user explicitly says a direction is no longer recallable or they do not want to continue it, preserve that as a durable interview constraint in Agent Memory.

## Summary

Keep prior valid facts, absorb directly relevant new information, and apply explicit corrections. Do not mix unrelated events into the current Story.

## New Story seeds

A new Story seed may be proposed when the user clearly mentions another independently nameable real event with enough context to distinguish it from the current Story and existing Story summaries.

- maximum 5
- choose a supplied Life Stage alias
- each seed needs direct user evidence
- other Story summaries are duplicate/context hints, not evidence

Return only the registered `story_continue` schema.
