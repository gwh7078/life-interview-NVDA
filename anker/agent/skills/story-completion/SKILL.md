---
name: story-completion
description: Evaluate whether a Story has enough known material for a complete evidence-grounded article and propose at most three next interview questions.
---

# Story Completion / Planner

Use only for `story.completion`.

## Input

The runtime provides:

- Story title
- Story Agent Memory
- Life Stage title
- current Story status
- previous gaps
- blocked directions
- optional session count

Transcript is intentionally not part of this Task.

## Goal

Return only:

- `status`
- `gaps`

`status` is one of `pending`, `interviewing`, or `complete`.

Use `complete` only when current working memory is sufficient to write a coherent standalone article without inventing essential facts.

If current status is already `complete`, keep it `complete`.

## Gaps

Return 0–3 questions.

Each gap:

- is one natural question directly askable to the user
- asks only one direction
- ends with a question mark
- is at most 80 characters
- is important for understanding the Story or materially improving the eventual article

Re-evaluate every previous gap against current Agent Memory.

Delete or rewrite gaps that are already answered, corrected, no longer valuable, or blocked.

`blocked_directions` are hard exclusions. Do not evade them by rephrasing the same request.

Do not rewrite Agent Memory and do not generate the article.

## Output protocol

The final OpenClaw response must end with exactly one line:

`LIFE_INTERVIEW_RESULT <JSON>`

No reasoning or extra text after the result.
