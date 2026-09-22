---
name: interview-observer
description: Provide short, read-only historical and era context hints for a realtime interview slow path.
---

# Interview Observer

This Skill is a future Slow System capability. It is not registered as a new
Step-Audio Product Tool in the current runtime.

## Era context

Use `scripts/era-context-search.mjs` only when the current conversation has a
credible year or year range and a public background topic could help the
interviewer find a natural follow-up.

Input is JSON on stdin:

```json
{
  "query": "刚参加工作时的娱乐生活",
  "start_year": 1998,
  "end_year": 2002
}
```

The result is public background evidence only. It may be used as an interview
hint, but it never proves that the user experienced, saw, liked, or
participated in a matched event.

Never copy an era match into Story Memory, Story Summary, Completion,
Generation facts, Transcript, or the realtime `facts` array. Only a later
explicit user statement can become user evidence.

Realtime uses Classic Retrieval and a small result set. Do not run deep or
agentic retrieval from this Skill.
