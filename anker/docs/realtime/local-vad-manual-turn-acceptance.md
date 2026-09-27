# Realtime 本地 VAD 与手动回合验收记录（历史 StepFun 路径）

日期：2026-09-24

> 本文记录的是 StepFun/Step-Audio 手动回合路径的历史验收。Local VAD controller 保留为 Provider-neutral 模块；仅当 Provider capability `manualTurnControl=true` 时启用。Step-Audio-2-mini 当前是正式的 StepFun Cloud Profile；本文旧版手动语音结果不代表本轮双 Profile 的实时验收。MiniCPM 的本地 VAD 接入与人工语音验收 **NOT TESTED**。当前 Provider 与慢路径状态见 [Realtime 双 Profile 与 Memory 验收报告](../07-reports/testing/REALTIME_DUAL_PROFILE_MEMORY_REPORT_v1.0.md)。

## 自动验证复跑

在项目根目录运行：

```bash
bash scripts/codex-node.sh npm run typecheck
bash scripts/codex-node.sh node --import tsx --test \
  public/local-vad-turn-controller.test.js \
  public/interview-state.test.js \
  test/modelbest-realtime-provider.test.ts \
  test/ai-task-config.test.ts \
  test/realtime-provider-contract.test.ts \
  test/realtime-end.test.ts \
  src/observability/observability.test.ts \
  src/realtime/trace.test.ts \
  test/server.test.ts
```

旧版 5 秒阈值的验证结果为：TypeScript 类型检查通过，针对性测试 61/61 通过。2026-09-24 在本地 main 将阈值调为 2 秒并修正 StepFun 手动回合能力与 session.updated 确认映射后，TypeScript 类型检查通过，针对性测试 64/64 通过。Realtime 测试使用本地模拟 Provider，不会请求外部模型；新增 Silero/ONNX 依赖从本地 npm 缓存离线安装。ModelBest 外部语音 E2E 和本地人工语音验收尚未运行。

测试覆盖启动必须等到 `session.updated` 明确确认手动回合、ONNX WASM 模块静态资源与 CSP、Silero VAD 回合阈值、单次 commit、回答期间不上传麦克风音频、工具 HOLD 期间服务端拒绝新语音，以及现有 Provider/观察层契约。

## 人工语音验收

1. 打开本地采访页并登录，进入首次建档访谈；确认对话先了解称呼、出生年份，再梳理人生阶段轮廓，然后才进入故事细节。
2. 确认 Provider 为 Step-Audio 2 Mini，允许浏览器使用麦克风。
3. 说一段包含自然停顿的完整回答。连续静音不足 2 秒时，观察采访官继续等待；达到 2 秒后，应提交这一轮并开始回答。
4. 采访官回答和语音播放期间继续说话，确认音频不会送入模型，也不会触发打断。
5. 若触发 Tool Calling，确认工具完成、采访官播完回答后，本地语音检测恢复；再说下一句，确认能开始新回合。
6. 结束采访并检查 Realtime trace 中的 `session.ending`、`provider.drain_completed` 和 `session.ended`；结束时会按需提交尚未提交的最后一段音频，正常情况下应在约 5 秒内完成，且 `drained=true`、`drainTimedOut=false`。Provider 未返回最终字幕时保留原有 20 秒完整性上限，并应以 `drained=false` 明确标记，保存字幕数应与已确认的 Transcript 数一致。
7. 同时检查 `local_vad_speech_started`、`local_vad_silence_started`、`local_vad_commit_triggered`、`provider.turn_detection_acknowledged` 和 `provider.response_done`。trace 只包含时序与状态字段，不应包含完整转录文本。

用户已人工确认旧版 5 秒静音阈值下 VAD 工作正常；本次改为 2 秒后的效果及结束收尾时长，仍待下一轮人工复测。`npm run test:voice:e2e` 未运行，该命令会向外部模型发送音频并消耗用量。
