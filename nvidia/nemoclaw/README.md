# NemoClaw / OpenShell / OpenClaw integration

Phase 1 uses the real OpenClaw runtime managed by NemoClaw/OpenShell.

## Onboard

```bash
nemoclaw agents list
nemoclaw onboard --name life-interview-agent
nemoclaw life-interview-agent status
nemoclaw inference get
```

OpenClaw is the default agent for normal NemoClaw onboarding. Do not use Pi in Phase 1.

## Install the smoke Skill

```bash
./deploy/mac/install-skill.sh
```

Equivalent:

```bash
nemoclaw life-interview-agent skill install ./agent/skills/story-context-inspector
```

## Programmatic turn

The Node AgentGateway uses the supported sandbox exec path:

```bash
nemoclaw life-interview-agent exec -- openclaw agent --agent main -m "..."
```

The actual Gateway also injects the short-lived Tool token as an in-sandbox process environment variable. Do not use raw `docker exec`: that bypasses the managed sandbox user/config path.

## Tool API network policy

OpenShell is deny-by-default. The host-side Tool API must listen on a private host address reachable by the OpenShell gateway and be explicitly allowed with the reviewed custom preset under `openshell-policy/`.

Do not rely on `host.docker.internal` as the general host Tool API route. Replace the example private IP with the actual host address and preview trusted-private-host pins before applying.

The Tool token is resource-scoped and expires shortly after the run window. Provider credentials remain managed by NemoClaw/OpenShell and never enter this repository.
