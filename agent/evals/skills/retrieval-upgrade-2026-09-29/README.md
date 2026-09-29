# Agent Skills Retrieval Upgrade Eval Pack

This is a new, source-controlled case pack for the next NVIDIA SkillEvaluator Tier 3 run. It does not replace or edit the 2026-09-28 v1 baseline.

`cases.jsonl` contains 20 paired task cases: 5 ordinary, 9 retrieval-required, and 6 hard negatives. `evidence-fixtures.jsonl` is an out-of-band Retriever fixture catalog. Fixture text must be indexed behind the scoped Evidence Search endpoint; it must never be copied into the With-Skill prompt.

For every case, With Skill and Without Skill must use the same model, current input, task, runtime settings, and judge. The only difference is whether the corresponding Skill is loaded. The harness may use `fixture_id` to provision retrieval data, but must not send it or fixture contents to the Agent.

## v1.1 准备入口

通过以下命令把当前 20 个 case 转成 Tier 3 准备清单（JSONL）：

```bash
bash scripts/codex-node.sh node agent/evals/skills/retrieval-upgrade-2026-09-29/prepare-evals.mjs > /tmp/retrieval-upgrade-v1.1-tier3-manifest.jsonl
```

清单包含配对条件、任务输入和独立的 fixture 预置元数据；fixture 正文不会写入任务输入。此脚本只生成清单，不会写入 Retriever，也不会运行 SkillEvaluator。执行 Live Tier 3 前，必须先按清单将 fixture 预置到对应 Retriever 范围；完整 v1.1 Tier 3 尚未运行。

## Initial smoke selection

| Skill | Ordinary | Retrieval required | Hard negative |
|---|---|---|---|
| interview-observer | OBS-N01 | OBS-R01 | OBS-H01 |
| onboarding-closeout | ONB-N01 | ONB-R01 | ONB-H01 |
| interview-closeout | IC-N01 | IC-R01 | IC-H01 |
| story-completion | SC-N01 | SC-R01 | SC-H01 |
| story-generation | SG-N01 | SG-R01 | SG-H01 |

Additional cases cover Completion title-scope regression, closeout Story deduplication, Era isolation, and Contributor isolation. They belong to the later full Tier 3 run. Observer remains a fixed, no-tool inference path: verify its Backend owner/Story prefetch separately, and do not count it as Agent-initiated Skill script use.

## Repeat and verify

1. Provision each fixture under the owner/Story/source-type scope recorded in the fixture catalog, using the product Retriever service for private sources and the separate public Era collection for Era.
2. Run each smoke case in paired With-Skill and Without-Skill conditions with identical model, input, runtime settings, and judge. For the four tool-enabled Skills, verify the Agent made a real Evidence Search script call only when needed; for Observer, verify the existing Backend prefetch and zero Agent script calls.
3. Save the Agent trace, Evidence Search trace, output, and judge result to a new dated result directory; do not write into `2026-09-28/`.
4. Verify retrieval-required cases used returned provenance; verify hard negatives made zero Agent script calls and stayed within their signed source allowlist. Record Observer's Backend prefetch separately. Verify no fixture content was inserted into either task prompt.

Live execution requires the operator-managed OpenClaw runtime and a reachable NeMo Retriever. A local deterministic capability test is not evidence of live Skill activation.
