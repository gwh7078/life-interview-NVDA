# NemoClaw / OpenShell / OpenClaw integration

> Phase 1 / Phase 2B-C 的历史 Smoke 描述仅作追溯。当前 Runtime 边界见 `docs/AGENT_RUNTIME.md` 与 `docs/REALTIME.md`。

Phase 1 uses the real OpenClaw runtime managed by NemoClaw/OpenShell.

## Onboard

```bash
nemoclaw agents list
nemoclaw my-assistant status
nemoclaw inference get
```

OpenClaw is the default agent for normal NemoClaw onboarding. Do not use Pi in Phase 1.

## Current NemoClaw-managed Skills

```bash
./deploy/mac/install-skill.sh
```

The Mac installer and Spark `sync_skills()` manage these Agent Runtime Skills:

- `onboarding-closeout`
- `interview-closeout` (including its `references/` files)
- `interview-observer`
- `story-completion`
- `story-generation`

`interview-coach` is also a formal Skill, but the custom low-latency Realtime
Runtime executes it through Qwen3-8B Gate → Retrieval → Resolve → Coach Packet.
It is not installed into NemoClaw/OpenClaw.

The legacy `story-context-inspector` Skill is retained only for the historical
Phase 1 Smoke and is not required by the formal six-path E2E.

## Programmatic turn

The Node AgentGateway uses the supported sandbox exec path:

```bash
nemoclaw my-assistant exec -- openclaw agent --agent main -m "..."
```

The actual Gateway also injects the short-lived Tool token as an in-sandbox process environment variable. Do not use raw `docker exec`: that bypasses the managed sandbox user/config path.

## Tool API network policy

OpenShell is deny-by-default. The host-side Tool API must listen on a private host address reachable by the OpenShell gateway and be explicitly allowed with the reviewed custom preset under `openshell-policy/`.

Do not rely on `host.docker.internal` as the general host Tool API route. Replace the example private IP with the actual host address and preview trusted-private-host pins before applying.

The Tool token is resource-scoped and expires shortly after the run window. Provider credentials remain managed by NemoClaw/OpenShell and never enter this repository.
