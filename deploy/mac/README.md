# Mac Phase 1 development

> 本文其余内容保留为 Phase 1 Smoke 的历史部署说明。当前正式产品验收使用 `./deploy/mac/install-skill.sh` 安装四个 Phase 2B-C Skill，并运行 `npm run test:agent:real`；当前固定 Runtime 是 NemoClaw `my-assistant` 中的 OpenClaw `main` Agent。Phase 2B-C 不需要启动 `npm run agent:tool-server`。

## Current Phase 2B-C verification

```bash
chmod +x ./deploy/mac/install-skill.sh
./deploy/mac/install-skill.sh
nemoclaw "$NEMOCLAW_SANDBOX" skill list
bash scripts/codex-node.sh npm run test:agent:real
```

需要先确认 `NEMOCLAW_SANDBOX` 指向实际可用 Sandbox；不要因为 `.env.example` 的示例值而创建第二个 Sandbox。

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

## 6. Sandbox data boundary

Do **not** onboard this sandbox with a host mount that exposes this repository, `data/`, or `memoir.db` inside the sandbox. The Agent must obtain product data only through the scoped Tool API.

The smoke Skill itself contains no database path and requires only the Tool API URL/token injected for one process invocation.

## 7. Recovery after Mac restart

1. Start Docker Desktop, or run `colima start`.
2. Run `docker info`.
3. Run `nemoclaw "$NEMOCLAW_SANDBOX" status`.
4. If onboarding was interrupted, use `nemoclaw onboard --resume`; otherwise follow the recovery command reported by `status`.
5. Run `nemoclaw inference get`.
6. Run `nemoclaw "$NEMOCLAW_SANDBOX" skill list` and reinstall the smoke Skill only if it is absent.
7. Run `nemoclaw "$NEMOCLAW_SANDBOX" policy list` and confirm the reviewed Tool API preset is present.
8. Start `npm run agent:tool-server`.
9. Run `npm run agent:smoke`.

The real hosted-model smoke is intentionally outside deterministic CI.
