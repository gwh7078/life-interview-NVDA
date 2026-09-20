---
name: story-context-inspector
description: Read one owner-scoped Story through the Life Interview Agent Tool API and report its title and gap count. Phase 1 smoke skill; read-only.
---

# Story Context Inspector

Use this skill only for the Phase 1 read-only smoke task.

## Rules

- Never open SQLite, memoir.db, application data files, or repository internals for product data.
- Read Story data only through the scoped Tool API below.
- Never print or repeat `LIFE_INTERVIEW_TOOL_TOKEN`.
- Do not mutate any product data.

## Tool call

The task message provides a `story_id`. Call:

```bash
curl -fsS -X POST \
  "$LIFE_INTERVIEW_TOOL_BASE_URL/internal/agent-tools/get_story_context" \
  -H "Authorization: Bearer $LIFE_INTERVIEW_TOOL_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"story_id":"<story_id>"}'
```

Read the returned JSON. Your final output must contain exactly one result line and no credential:

```text
LIFE_INTERVIEW_RESULT {"title":"<story title>","gap_count":<integer>}
```
