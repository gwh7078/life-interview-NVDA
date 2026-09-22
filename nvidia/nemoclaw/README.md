# NemoClaw / OpenShell / OpenClaw integration

> 本文的 Tool API 与 `story-context-inspector` 部分是 Phase 1 历史 Smoke 说明。当前正式产品链路见 `docs/05-development/phases/PHASE_2B_C_PRODUCT_RUNTIME_INTEGRATION_v1.0.md`，使用一个 `main` Agent 和四个正式 Skill。

Phase 1 uses the real OpenClaw runtime managed by NemoClaw/OpenShell.

## Onboard

```bash
nemoclaw agents list
nemoclaw my-assistant status
nemoclaw inference get
```

OpenClaw is the default agent for normal NemoClaw onboarding. Do not use Pi in Phase 1.

## Install the formal Phase 2B-C Skills

```bash
./deploy/mac/install-skill.sh
```

The installer installs:

- `onboarding-closeout`
- `interview-closeout` (including its `references/` files)
- `story-completion`
- `story-generation`

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
