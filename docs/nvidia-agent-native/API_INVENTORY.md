# API inventory

This inventory freezes the externally relevant route families in the imported baseline. Exact request/response behavior remains protected by the imported tests.

| Route family | Auth | Disposition |
|---|---|---|
| `/api/health` | public | KEEP |
| `/api/stories`, `/api/stories/:id` | owner | KEEP |
| `/api/stories/:id/title` | owner | KEEP |
| `/api/stories/:id/stage` | owner | KEEP |
| `/api/stories/:id/documents*` | owner | KEEP |
| `/api/stories/:id/share-links` | owner | KEEP |
| `/api/story-share-links/:id` | owner | KEEP |
| `/api/public/story-share/:token` | share token | KEEP |
| `/api/public/story-share/:token/retry-closeout` | share token | KEEP |
| `/api/life-stages*` | owner | KEEP |
| `/api/onboarding/result` | owner | KEEP |
| `/api/onboarding/sessions/:id/closeout` | owner | KEEP |
| `/api/interview-sessions/:id/closeout` | owner | ADAPT later to Agent workflow |
| `/api/interview-sessions/:id/result*` | owner | KEEP |
| `/api/book*` | owner | KEEP |
| `/api/realtime` WebSocket | owner/session | KEEP |
| `/internal/agent-tools/*` | agent run token | ADD Phase 1 |

Phase 1 internal Tool routes are not browser APIs and must never accept ordinary browser auth as a substitute for scoped Agent credentials.
