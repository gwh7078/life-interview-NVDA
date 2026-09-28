# NVIDIA SkillEvaluator 审查与优化记录

日期：2026-09-28

范围：Agent Skills 文档、声明边界与现有验证；未修改产品运行时代码、数据库 schema、Provider、Coach/Gate/Retriever 架构或业务流程。

## 1. 范围与来源

原范围内的五个正式 Agent-task Skills：

- `onboarding-closeout`
- `interview-closeout`
- `interview-observer`
- `story-completion`
- `story-generation`

用户随后要求从 GitHub 获取 `agent/skills/interview-coach/SKILL.md`。该文件来自 `gwh7078/life-interview-NVDA` 的 `origin/main`，来源提交 `8006d01d594f74423aac04638c11696fa195e513`；本轮将它作为第六份 Skill 一并审查。Coach 由自定义低延迟 Realtime runtime 执行，不属于通用 OpenClaw Skill 安装清单。`story-context-inspector` 仍是历史诊断/测试用途，不计为正式产品 Skill。

五个原有 Skill 的优化前材料取自 `9cd1412` 基线；Coach 优化前材料是上述 GitHub 源文件。此工作区基于 `15bc8ea0a61a20c676f8bd3b7eb35430bd030994`。

## 2. 方法与工具版本

主要标准使用 NVIDIA 官方 [SkillEvaluator](https://docs.nvidia.com/skills/skillevaluator/installation) Tier 1 和 Tier 2；按官方说明，Tier 2 相似度分析需要 embedding provider，Tier 3 属于后续 live evaluation。另运行 SkillSpector、Semgrep、Gitleaks 和项目现有检查。

| 工具 | 版本 | 来源/说明 |
|---|---:|---|
| SkillEvaluator | 0.3.0 | NVIDIA/SkillEvaluator，commit `a2636b2f886235f974ed4329029f923a12d0328b` |
| Python（SkillEvaluator 环境） | 3.13.15 | uv tool 环境；系统默认 Python 版本未用于 SkillEvaluator |
| SkillSpector | 2.12.0 | commit `89e90872e2ec813bcb137bf6b3145c92e55811ae` |
| Semgrep | 1.178.0 | Tier 1 静态代码扫描 |
| Gitleaks | 8.30.1 | Tier 1 密钥扫描 |
| 执行日期 | 2026-09-28 | 本地工作区 |

Tier 1 使用 `--no-llm`。因此下面的结果是本地静态/规则检查，不包括模型评审；它们不构成 NVIDIA Verified 认证。NVIDIA 对 [Tier 1](https://docs.nvidia.com/skills/skillevaluator/tier1-validation) 的说明将缺少作者信息列为 Schema 高严重级问题。Tier 2 provider 要求见 [Tier 2 去重说明](https://docs.nvidia.com/skills/skillevaluator/tier2-deduplication)。

## 3. 优化前后

| Skill | Baseline 分数 | Final 分数 | 变化 | Tier 1 Schema / Security（Baseline → Final） | 主要修改 |
|---|---:|---:|---:|---|---|
| onboarding-closeout | 87.2 B | 89.5 B | +2.3 | FAIL / PASS → FAIL / PASS | 用途、触发条件、排除场景更明确；补版本与 tags |
| interview-closeout | 83.0 B | 87.8 B | +4.8 | FAIL / INCOMPLETE → FAIL / INCOMPLETE | 明确 Story/Contributor 与其他阶段的职责边界；保留并说明受控检索约束 |
| interview-observer | 84.8 B | 89.5 B | +4.7 | FAIL / INCOMPLETE → FAIL / PASS | 明确只读上下文提示职责和输入注入边界；移出不属于其调用链的 Era helper |
| story-completion | 85.5 B | 87.8 B | +2.3 | FAIL / PASS → FAIL / PASS | 明确只依据 Story Memory 规划、不读取 Transcript、不写作；增加输入文本边界 |
| story-generation | 83.0 B | 87.8 B | +4.8 | FAIL / PASS → FAIL / PASS | 语义保持式压缩主 Skill；按需加载文风与 revision reference |
| interview-coach | 88.0 B | 92.8 A | +4.8 | FAIL / PASS → FAIL / PASS | 标准化描述、版本和 tags；将 Contributor 不检索的说明对齐当前 runtime |

除表中的 Schema 与 `interview-closeout` Security 外，最终 Tier 1 的语义版本、PII、许可证、代码风险、密钥、依赖、Unicode、质量与脚本 lint 项均显示 PASS。Tier 1 的 Code Integrity 提示没有找到其支持的标准 Python 测试候选，因此没有执行目标测试或测量覆盖率；它的 PASS 不能解读成项目测试通过。JavaScript 脚本另用 Node 语法检查，并运行项目测试。

Baseline 的五个原有 Skills 在静态扫描器安装完成后重新运行并保存 `*.scanner-complete.txt`；最早一次运行因缺少扫描器的结果也保存在目录中。比较表使用扫描器可用时的结果。Coach 的 baseline 直接以 GitHub 文件为输入。所有原始质量分、Tier 1 输出和 SkillSpector JSON 均保存在本报告后文列出的证据目录。

## 4. Tier 1 未解决项

### Schema

六份 Skill 均为 **Schema & Repository Governance FAIL**：缺少 `metadata.author`，SkillEvaluator 将其报告为一个 HIGH 错误。仓库中没有可确认的公开维护者邮箱；没有把本机私有 Git 邮箱或臆造地址写入 Skill。

每份 Skill 另有两个 MEDIUM 建议：使用固定的 `## Instructions` 和 `## Examples` 标题。现有正文已有用途、规则和输入输出要求；本轮没有为匹配标题启发式而插入空洞章节或人为示例。

### Security / permissions

- 五份 Skill 的 Security Scan 为 PASS。
- `interview-closeout` 为 **INCOMPLETE**，不是安全通过：SkillSpector 对 `scripts/memory-search.mjs` 的安全相关表达式触及 `static_parse_limit`，只完成部分静态解析。其 HIGH `analysis-evasion` finding 指向“引用脚本未完整分析”，工具也说明这不是恶意规避的证据。另有 MEDIUM LP3，原因是 Skill 没有通用 `allowed-tools` 声明。
- 当前系统由自定义 Agent runtime 的 `scriptCapabilities` 限制脚本能力，`memory-search` 还需 Backend 注入并验证的短时签名 token。通用 `allowed-tools` 无法准确表示该运行时授权边界；没有为消除 LP3 而添加会误导或放宽权限的声明。该告警保留待后续由扫描器适配或定义准确能力格式。
- `story-generation` 的 SkillSpector 分析完整度为 100%，没有发现项。其他扫描信息见 Tier 1 原始输出；结构化 SkillSpector JSON 单独保存了 `interview-closeout` 与 `story-generation` 两份结果。

`interview-closeout/scripts/memory-search.mjs` 的有效保护仍包括：query 长度限制为 2–500 字符；只在 `story_continue` 授权；scope 由 Backend 根据当前 owner、Story 和来源类型确定并校验，Agent 不传 owner/Story scope；最多返回 5 项；10 秒超时；凭证由 runtime 注入；日志只写安全状态/计数，不输出 token 或完整 Transcript；不直接访问 SQLite。检索失败不改变已保存事实，也不能覆盖当前 Transcript 中明确的纠正。

NVIDIA [SkillSpector 最小权限分析说明](https://github.com/NVIDIA/SkillSpector/blob/main/docs/B.3.1-mcp-least-privilege.md) 描述了其权限声明分析；当前项目自定义 runtime 能力不完全对应该通用声明模型，因此报告区分扫描器告警与代码中真实授权路径。

## 5. Skill 内容与运行时边界

- 六份 Skill 的 description 均改为自然语言用途、触发场景和排除场景，并增加 `version: 1.0.0`、tags。没有补写未经实现验证的能力。
- `story-generation/SKILL.md` 从 369 行压缩至 47 行。事实证据优先级、禁止虚构、不确定性、后续纠正、Contributor 隔离、initial/revision 区别和输出边界留在主文件。详细中文回忆录文风保留在 `references/chinese-memoir-style.md`；revision 专属规则放入新建的 `references/revision.md`，只有 revision 模式读取。文风 reference 不得覆盖主文件的事实边界和输出协议。
- `interview-observer/scripts/era-context-search.mjs` 没有实际进入 Observer 或 Realtime Coach 的执行路径。已确认 Coach 使用现有 `RealtimeCoachPipeline` / `EraContextClient` 独立进行 Personal Memory 与 Era Context 查询；只把原脚本移到 `scripts/era-context-search.mjs`，移动前后文件字节一致。Coach 现有 Era Retrieval 运行时保持不变。
- 更新 `docs/03-agent/SKILL_SCRIPT_MAPPING_v1.0.md`，区分 Agent-task、Observer、Coach 和独立 Era helper，并说明 runtime `scriptCapabilities` 授权边界。
- Prompt injection 边界补充到 Observer 与 Story Completion：Transcript、答案、记忆、标题、Life Stage 等均作为数据处理，不能覆盖 Skill 规则。
- `interview-coach` 明确属于自定义 Realtime runtime，而不是通用 OpenClaw 安装路径；其 retrieval 说明与当前 mode 实现一致。

### 行为与数据边界核对

本轮未修改产品业务行为、Task Contract、JSON schema、数据库、Provider、Coach/Gate/Retriever 实现或部署代码。与这些边界相关的当前源文件相对 `origin/main` 未修改。唯一移动的是未被当前调用链使用的 Era 搜索辅助脚本，且文件内容未改；实际 Coach Era retrieval 路径未改。

## 6. Tier 2 状态

| 检查 | Baseline | Final | 结果 |
|---|---|---|---|
| 六个 Skill 的跨 Skill similarity/catalog | INCOMPLETE | INCOMPLETE | embedding provider 未配置，catalog 未生成，不能报告相似度或去重 PASS |
| story-generation intra-skill | INCOMPLETE | INCOMPLETE | Baseline 与 final 均因无 embedding provider 结束 |
| 其余五个 Skill intra-skill | 未执行 | 未执行 | provider 预检已显示不可用，未重复运行等价失败 |

两次跨 Skill 执行均报告 `Embedding provider error: No provider is configured.` 因而本轮无法给出 inter-skill 分数、catalog 或重复率。SkillEvaluator 的配置说明列出了可配置的 NVIDIA Build/OpenAI embedding provider；后续在安全环境提供 provider 后即可按复现命令重跑。按用户要求，Tier 3 分数不是本轮通过条件，也没有创建虚构数据集或运行 live evaluation。

## 7. Tier 3 数据集准备建议

优先次序与建议维度：

1. **interview-closeout**：明确证据抽取；不确定性保留；主人公后续纠正优先；相互矛盾的证据；Contributor hearsay 隔离；当前 Story scope；未授权检索拒绝；Transcript 中的 prompt injection。
2. **story-completion**：资料不足与充分；gap 已被回答；方向被阻断；低价值 gap；不确定性；重复问题识别；不得把 Completion 判断扩展为正文写作。
3. **story-generation**：无证据事实幻觉；不确定性和纠正保留；revision 结构/声线保留；用户风格要求；Contributor 隔离；Transcript 中的 prompt injection；无授权时避免整篇重构。

后续应为每个维度准备带明确预期结果的合成样例，并分别评估事实正确性、边界遵循和格式/契约；本轮没有生成测试数据，也没有用模型打分。

## 8. 项目检查

| 检查 | 结果 |
|---|---|
| `bash scripts/check-ai-env.sh` | PASS（开发前本机环境检查） |
| `bash scripts/codex-verify.sh` 内的 typecheck | PASS |
| `test:fast` | **FAIL：250 pass / 1 fail**。失败在未修改的 `src/observability/observability.test.ts:426`，断言技术观察中的 first-audio 延迟应为 `620 ms`，实际为 `—`。测试事件使用 `component=realtime-tool-cycle`，当前未修改 Observer 实现仅在 `component=realtime-provider` 时填充该值。未修改 Observer 代码或测试来规避此失败。 |
| `test:integration` | PASS：81 pass / 0 fail |
| `test:agent` | PASS：37 pass / 0 fail |
| `test:agent:nat:unit` | PASS：8 tests |
| `node --check agent/skills/interview-closeout/scripts/memory-search.mjs` | PASS（经 `bash scripts/codex-node.sh`） |
| `node --check scripts/era-context-search.mjs` | PASS（经 `bash scripts/codex-node.sh`） |
| `git diff --check` | PASS |
| Live voice E2E | NOT RUN；项目指令要求仅在明确请求 live-provider 验证时运行 |

`test:integration` 有 `[realtime-trace] write failed (ENOENT)` 诊断警告，但该套件仍为 81/81 通过。Agent/NAT/Integration 详细输出和 suite 状态位于 `docs/07-reports/skills/after/2026-09-28/tests/`。Fast suite 的单一失败已在本表记录；没有把它归因于 Skill 文档更改。

## 9. 复现命令

项目 Node/npm 命令均通过项目 wrapper：

```bash
for skill in onboarding-closeout interview-closeout interview-observer story-completion story-generation interview-coach; do
  skillevaluator quality-check "./agent/skills/$skill"
  skillevaluator tier1 "./agent/skills/$skill" --no-llm
done

skillevaluator similarity-check ./agent/skills \
  --save-catalog docs/07-reports/skills/skill-catalog.json
skillevaluator tier2 ./agent/skills/story-generation

bash scripts/codex-node.sh node --check agent/skills/interview-closeout/scripts/memory-search.mjs
bash scripts/codex-node.sh node --check scripts/era-context-search.mjs
bash scripts/codex-verify.sh
```

本轮 Tier 2 命令因 provider 缺失而未产生 catalog；上面命令仅在 `SKILL_EVAL_EMBEDDING_PROVIDER` 与对应 provider 凭证在安全环境中配置后可得到完整结果。不要把 key 放进 Skill、报告或 shell 日志。

## 10. 原始证据

- 五个原有 Skill baseline：`docs/07-reports/skills/baseline/2026-09-28T1012-0800-9cd1412/`
- Coach GitHub baseline：`docs/07-reports/skills/baseline/2026-09-28-interview-coach-8006d01/`
- 最终质量、Tier 1 与 SkillSpector 输出：`docs/07-reports/skills/after/2026-09-28/`
- Tier 2 baseline/final 输出：`docs/07-reports/skills/after/2026-09-28/tier2/`
- Integration、Agent、NAT suite 日志：`docs/07-reports/skills/after/2026-09-28/tests/`

本地 SkillEvaluator 分数和 PASS 状态仅描述上述版本、参数和本地扫描结果，不代表 NVIDIA 认证或 NVIDIA Verified Skill。
