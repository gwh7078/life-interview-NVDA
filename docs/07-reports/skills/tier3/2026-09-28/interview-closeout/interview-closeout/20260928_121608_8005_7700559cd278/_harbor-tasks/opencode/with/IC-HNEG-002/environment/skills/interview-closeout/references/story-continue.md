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

Return only the registered `story_continue` schema:

```json
{
  "current_story": {
    "summary": "...",
    "agent_memory": "...",
    "memory_changes": [{
      "type": "correct",
      "previous_text": "用户大约在2012年前后第一次独自去北京工作。",
      "new_text": "用户是2013年春节以后第一次独自去北京工作的。",
      "source_message_ids": ["m2"]
    }],
    "source_message_ids": ["m2", "m3"]
  },
  "new_stories": []
}
```

`current_story` contains only `summary`, `agent_memory`,
`memory_changes`, and `source_message_ids`. Each memory change uses exactly
`type`, `previous_text`, `new_text`, and `source_message_ids`; do not use
`change_type`, `evidence`, `mode`, or `status`. Use the transcript aliases
(`m1`, `m2`, ...) for `source_message_ids`.
