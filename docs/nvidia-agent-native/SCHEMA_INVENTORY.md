# Schema inventory

Baseline tables:

- `accounts`
- `users`
- `life_stages`
- `stories`
- `story_share_links`
- `interview_sessions`
- `memoir_documents`
- `memoir_books`
- `memoir_book_items`

Important state:

- onboarding: `not_started | in_progress | completed`
- life stage: `active | pending | merged`
- story: `pending | interviewing | complete`
- session provider: `doubao | qwen | openclaw`
- session: `active | ended | processing | completed`
- closeout: `pending | processing | completed | failed`
- interview source: `subject | external_contributor`
- share: `active | revoked`

Critical product columns include `stories.summary`, `stories.agent_memory`, `stories.gaps_json`, `interview_sessions.transcript_json`, closeout state, provider identity and contributor linkage.

Baseline migrations: `0000` through `0009_story_share_contributors.sql`. Phase 1 may append a migration for `agent_runs`; existing tables are not cleaned up or reshaped.
