# Mac Phase 1 development

Target: Apple Silicon macOS with Docker Desktop or Colima, real NemoClaw/OpenShell/OpenClaw, and NVIDIA Hosted inference.

## 1. Verify environment

```bash
./deploy/mac/check-env.sh
```

## 2. Install smoke Skill

```bash
./deploy/mac/install-skill.sh
```

## 3. Start the Node Tool API

Create `.env` from `.env.example`. Generate a random `AGENT_TOOL_TOKEN_SECRET` with at least 32 bytes.

The default Tool host is loopback for safety. For the sandbox smoke test, bind it to a developer-host private interface reachable by the OpenShell gateway and set `AGENT_TOOL_BASE_URL` to that same URL.

```bash
npm run agent:tool-server
```

Verify it from the host first:

```bash
curl -s http://<PRIVATE_HOST_IP>:4175/health
```

## 4. Apply the reviewed private-host policy

Copy the example to a local YAML, replace `10.0.0.5` with the exact reachable private host IP, then preview:

```bash
nemoclaw "$NEMOCLAW_SANDBOX" policy add \
  --from-file ./nvidia/nemoclaw/openshell-policy/life-interview-tool-api.yaml \
  --trusted-private-host <PRIVATE_HOST_IP> \
  --dry-run
```

Review the generated address pins and the binary/method/path/port limits. Then apply the same command without `--dry-run`.

Do not disable the OpenShell proxy and do not use `host.docker.internal` as a shortcut.

## 5. Run the smoke chain

Set `AGENT_SMOKE_USER_ID` and `AGENT_SMOKE_STORY_ID` to an owner/story pair in the local database.

```bash
npm run agent:smoke
```

Expected chain:

```text
Node AgentGateway
→ nemoclaw <sandbox> exec
→ OpenClaw main agent
→ story-context-inspector Skill
→ scoped get_story_context HTTP Tool
→ structured LIFE_INTERVIEW_RESULT
→ agent_runs.status = succeeded
```

The real hosted-model smoke is intentionally outside deterministic CI.
