# Agent Skills

Life Interview currently has **6 formal product Skills**:

| Skill | Role |
|---|---|
| [interview-coach](interview-coach/SKILL.md) | Realtime Gate / Retrieval / next-question guidance |
| [onboarding-closeout](onboarding-closeout/SKILL.md) | Profile, Life Stage, and Story Seed extraction after onboarding |
| [interview-closeout](interview-closeout/SKILL.md) | Evidence-based closeout for Story and Contributor interviews |
| [story-completion](story-completion/SKILL.md) | Story completeness judgment and high-value gaps |
| [story-generation](story-generation/SKILL.md) | Evidence-grounded initial / revision memoir writing |
| [interview-observer](interview-observer/SKILL.md) | Low-latency read-only observation and diagnostics |

The competition narrative focuses on the first five business Skills; `interview-observer` is an auxiliary diagnostic Skill.

`story-context-inspector/` is a historical smoke / diagnostic helper and is **not** counted as a formal product Skill.

Each formal Skill defines its trigger, input or mode, evidence boundary, output contract, runtime behavior, and prohibited actions. Backend validation remains authoritative; Skills do not directly mutate the business SQLite database.
