# Phase 1 real NemoClaw smoke checklist

Run this only after local NemoClaw/OpenShell/OpenClaw onboarding is complete.

## Preconditions

- Docker Desktop or Colima is running.
- `nemoclaw <sandbox> status` reports the sandbox ready/running.
- `nemoclaw inference get` shows the intended NVIDIA hosted provider/model.
- The sandbox was created **without** mounting this repository, `data/`, or `memoir.db`.
- The local product database contains an owner/story pair for the smoke test.

## 1. Prepare environment

Create `.env` from `.env.example`.

Required Phase 1 values:

```bash
NEMOCLAW_SANDBOX=life-interview-agent
AGENT_TOOL_HOST=<PRIVATE_HOST_IP>
AGENT_TOOL_PORT=4175
AGENT_TOOL_BASE_URL=http://<PRIVATE_HOST_IP>:4175
AGENT_TOOL_TOKEN_SECRET=<32+ random bytes>
AGENT_RUNTIME_TIMEOUT_MS=120000
AGENT_SMOKE_USER_ID=<owner user id>
AGENT_SMOKE_STORY_ID=<story id owned by that user>
```

Do not commit `.env`.

## 2. Verify runtime

```bash
./deploy/mac/check-env.sh
```

## 3. Install Skill

```bash
./deploy/mac/install-skill.sh
nemoclaw "$NEMOCLAW_SANDBOX" skill list
```

Confirm `story-context-inspector` is visible.

## 4. Start Tool API

```bash
npm run agent:tool-server
```

From another terminal on the host:

```bash
curl -s "$AGENT_TOOL_BASE_URL/health"
```

Expected:

```json
{"status":"ok","service":"life-interview-agent-tools"}
```

## 5. Apply OpenShell policy

Copy the policy example, replace the example IP with the same exact private host used by `AGENT_TOOL_BASE_URL`, then preview:

```bash
nemoclaw "$NEMOCLAW_SANDBOX" policy add \
  --from-file ./nvidia/nemoclaw/openshell-policy/life-interview-tool-api.yaml \
  --trusted-private-host <PRIVATE_HOST_IP> \
  --dry-run
```

Review the generated IP pins, requesting binary, port, HTTP method and path. Apply only after the preview matches the intended scope.

## 6. Confirm sandbox reaches only the reviewed Tool route

Inside the sandbox, test only the public health route:

```bash
nemoclaw "$NEMOCLAW_SANDBOX" exec -- curl -s "$AGENT_TOOL_BASE_URL/health"
```

Do not place a Tool token manually in shell history.

## 7. Run real smoke

```bash
npm run agent:smoke
```

Expected result shape:

```json
{
  "runId": "...",
  "status": "succeeded",
  "output": {
    "title": "...",
    "gap_count": 0
  }
}
```

`gap_count` may be 0–3 depending on the Story.

## 8. Verify persistence and audit

Confirm:

- the matching `agent_runs` row reached `succeeded`;
- runtime is `nemoclaw-openclaw`;
- latency is present;
- no raw Tool token appears in result JSON;
- `runtime/diagnostics/agent-tools.jsonl` contains an allowed `get_story_context` audit entry;
- no product DB file exists inside the sandbox due to project/data host mounting.

## Failure classification

- `AGENT_RUNTIME_TIMEOUT`: NemoClaw/OpenClaw turn exceeded timeout.
- `AGENT_RUNTIME_EXEC_FAILED`: sandbox/agent invocation failed.
- `INVALID_TOKEN` / `TOKEN_EXPIRED`: Tool credential failed.
- `TOKEN_SCOPE_MISMATCH`: requested Story does not match the run token.
- `STORY_NOT_FOUND`: token owner cannot access that Story.
- `AGENT_RESULT_MISSING`: Agent did not emit the required result marker.
- `AGENT_RESULT_INVALID`: returned marker JSON did not satisfy the smoke contract.

Do not move to Phase 2 until this checklist completes end-to-end on the real Mac sandbox.
