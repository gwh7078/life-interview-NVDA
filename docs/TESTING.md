# Testing & Acceptance

> 当前测试与验收入口，更新于 2026-09-27。

## 1. 原则

测试分三类，不能混写：

```text
Deterministic / Integration
≠ Live Provider Smoke
≠ Human Experience Acceptance
```

自动化 PASS 只证明代码合同与受控依赖，不代表真人语音体验已经通过。

## 2. 日常验证

项目约定优先使用：

```bash
bash scripts/codex-node.sh npm run typecheck
bash scripts/codex-node.sh npm run test:fast
bash scripts/codex-node.sh npm run test:integration
bash scripts/codex-node.sh npm run test:agent
bash scripts/codex-node.sh npm run test:agent:nat:unit
```

完整确定性验证：

```bash
bash scripts/codex-verify.sh
```

开发时先跑受影响 targeted tests；不要为没有真实行为差距的问题机械增加测试。

## 3. Realtime Live

### 通用真实 Provider E2E

```bash
npm run test:voice:e2e
```

会调用外部模型并消耗额度，只在明确需要真实 Provider 验证时执行。

### Mini Coach

```bash
npm run test:realtime:coach:live
```

重点验证：

- ASR final；
- Gate；
- action=none 快路径；
- Coach 指导；
- Story Continue Memory / Era；
- Deadline；
- Mini response；
- trace / observer。

### StepAudio 3 Context Agent

```bash
npm run test:realtime:agent:smoke
```

只证明 `interview.context_hint` Agent Runtime，不代表 Mini Coach。

## 4. Retriever / Era

相关命令：

```bash
npm run test:phase3:integration
npm run era:dataset:validate
npm run era:index
npm run era:benchmark
```

Era Benchmark 要区分：

- Dataset / Index 可用；
- Query 命中；
- Coach 是否实际采用；
- 最终采访问题是否改善。

## 5. Agent / NAT

```bash
npm run test:agent:real
npm run test:agent:nat:smoke
npm run test:agent:nat:profile
npm run test:agent:nat:eval
```

真实 Agent 报告应记录具体环境、模型与 commit，不把旧 PASS 自动继承给未来版本。

## 6. 人工语音验收

当前必须持续人工验收四种场景：

- Onboarding；
- Story Create；
- Story Continue；
- External Contributor。

重点不是“能不能说话”，而是：

- 开场是否可靠；
- 用户回答后是否继续自然追问；
- 是否频繁重复；
- 是否被单个话题带偏；
- 是否错误使用历史信息；
- Era Context 是否只用于启发追问；
- 小模型是否遵守一次只问一个问题；
- 中断/打断体验；
- 结束协议；
- Transcript / Closeout / Completion 是否完整。

## 7. 文档证据规则

`docs/07-reports/` 保存某次验证的证据。

报告顶部必须能回答：

- 日期；
- commit / baseline；
- 环境；
- 真实还是 deterministic；
- PASS / FAIL / NOT TESTED；
- 后续是否被 superseded。

不要再把旧测试报告放进 Current 推荐阅读路径。
