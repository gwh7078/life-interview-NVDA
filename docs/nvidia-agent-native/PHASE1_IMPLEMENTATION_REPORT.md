# Phase 1 implementation report

Date: 2026-09-20  
Branch: `nvidia/agent-native`  
Baseline source: `gwh7078/life-interview@f05b22ce57ae06e4e619bd53218278e6937475e4`

## Implemented

- imported the current runnable Web/server baseline without changing legacy product behavior;
- added `agent_runs` persistence with queued/running/succeeded/failed states;
- added `AgentGateway` and a NemoClaw/OpenClaw adapter;
- added short-lived HMAC Tool tokens scoped by run, owner, tool, resource type and resource id;
- added read-only `get_story_context`;
- added structured Tool errors and JSONL audit events;
- added `story-context-inspector` smoke Skill;
- added a deny-by-default OpenShell custom policy example for the host Tool API;
- added Mac environment, Skill install, Tool server, policy preview/application and recovery instructions;
- added Agent unit/integration tests;
- CI now runs on `nvidia/**` branches.

## Runtime chain implemented

```text
Node AgentGateway
→ nemoclaw <sandbox> exec
→ openclaw agent --agent main
→ story-context-inspector
→ POST /internal/agent-tools/get_story_context
→ owner-scoped Repository read
→ LIFE_INTERVIEW_RESULT
→ agent_runs succeeded/failed
```

The Gateway intentionally uses `nemoclaw <sandbox> exec` rather than raw `docker exec`. This allows the short-lived Tool token to be injected as an in-sandbox process environment variable rather than being placed in the model prompt.

## Automated verification

GitHub Actions run: `35493672946`  
Verified commit: `819f833ebc240cbc41ffb51d46307620c822ce2d`

Results:

- checkout: passed;
- dependency install: passed;
- TypeScript typecheck: passed;
- full deterministic verification: passed;
- legacy product tests: included;
- new `test:agent` unit/integration suite: included.

## Phase 1 gate status

### Passed in repository / CI

- Agent Gateway contract;
- Tool auth and resource scope;
- owner scope;
- invalid resource behavior;
- runtime timeout behavior;
- agent run lifecycle persistence;
- migration/typecheck/regression compatibility;
- Mac/NemoClaw/Skill/policy/recovery assets committed;
- no third-party NVIDIA/OpenClaw source code vendored.

### Pending real local environment

The final real-runtime smoke gate is **not claimed as passed yet** because this execution environment cannot access the user's Mac NemoClaw/OpenShell sandbox or NVIDIA hosted inference route.

Still to run locally:

```text
Node creates Agent Run
→ real NemoClaw/OpenClaw executes
→ real sandbox curl reaches host Tool API under OpenShell policy
→ get_story_context returns the selected Story
→ hosted model returns structured result
→ agent_runs.status = succeeded
```

Use `docs/nvidia-agent-native/PHASE1_SMOKE_CHECKLIST.md`.
