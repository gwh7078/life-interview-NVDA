# 人生采访局 · Life Interview

> **7 天，只说话不写字，完成一部约 10 万字个人回忆录。**  
> AI 回忆录记者用“听、问、辨、写”完成持续采访、证据核对、缺口发现和最终成稿。

**DGX Spark：FULL LOCAL VERIFIED / OFFLINE CAPABLE。**  
Text / Agent、Qwen3-8B Coach、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、Backend / Web、SQLite 均已在 NVIDIA DGX Spark GB10 本地运行；断开外部网络后产品主链仍可使用，真人连续语音操作流畅。

---

## 1. 评委评分速览

| 评分项 | 项目得分点 |
|---|---|
| **实用性 / 行业落地 / 技术创新 · 25%** | 用持续语音采访替代“让用户自己写”；快慢系统解决实时自然度与专业追问冲突；证据链避免长访谈事实漂移 |
| **智能体与模型优化技术深度 · 25%** | 6 个正式 Agent Skills；NemoClaw / OpenClaw Agent Loop；受限 Tool Call；NeMo Retriever；Schema / Evidence / Domain Validation；Validation / Format Repair；快慢模型分工 |
| **项目完整性 · 20%** | Onboarding → Story → 连续采访 → 第三方旁证 → Closeout → Completion / Gaps → Story Generation → Book / PDF，全链 Web 产品可运行 |
| **平台适配性 · 15%** | DGX Spark GB10 全本地、可断网；Qwen3.6 NVFP4 + Qwen3-8B + Step-Audio-2-mini + NeMo Retriever + NemoClaw / OpenClaw + NAT |

---

## 2. 核心架构：快系统负责自然，慢系统负责专业

```text
用户语音
   ↓
Step-Audio-2-mini Realtime
   │
   ├──────────────→ 直接自然追问
   │
   └→ interview-coach / Qwen3-8B
          Gate：是否需要介入？
             │
          ┌──┴──────────┐
          │             │
     Story Memory    Era Context
       Retrieval      Retrieval
          └──────┬──────┘
              Resolve
                 ↓
           Coach Packet
                 ↓
           下一轮自然追问
```

关键优化：

- **Gate ≤ 2s，Coach 总 Deadline ≤ 6s**；
- Memory / Era **按需检索，可并行**；
- 超时、失败、stale 结果全部 **fail-open**，不阻塞语音；
- Realtime Voice、Coach、Text / Agent 使用不同模型与 endpoint；
- 长期证据进入 Retriever，不把全部历史塞回语音模型上下文。

---

## 3. Agent Skills：真正的 Agent Loop、Tool Call 与 Runtime

项目有 **6 个正式 Skills**。比赛主线是 5 个业务 Skill；`interview-observer` 是辅助实时观察 Skill。

### 3.1 会后 Agent 执行循环

```text
Backend Task Router
      ↓
Task Definition
Skill / Model / Timeout / Tool Allowlist
      ↓
NemoClaw / OpenClaw Agent
      │
      ├─ 可选 Tool Call：evidence-search
      │      ↓
      │   NeMo Retriever
      │
      ↓
Proposal
      ↓
Schema → Evidence → Domain Validation
      │
      ├─ Reject → Validation / Format Repair → Retry
      │           （最多 3 次）
      ↓
Apply
```

四个核心会后 Skill 可在需要时调用各自打包的 `scripts/evidence-search.mjs`；Backend 控制 owner、Story、Contributor lane、source allowlist、token、结果数量与 provenance，Agent 不能自行扩大检索范围。

### 3.2 Skill 技术实现与实测

| Skill | Runtime / Loop / Tool | 实测结果 |
|---|---|---:|
| [**interview-coach**](agent/skills/interview-coach/SKILL.md) | 独立低延迟 Runtime；**Gate → 可选 Memory/Era Retrieval → Resolve**；不走通用 OpenClaw Loop | 下一问综合质量 **+55%** |
| [**onboarding-closeout**](agent/skills/onboarding-closeout/SKILL.md) | OpenClaw Agent Loop，最多 3 attempts；可 Tool Call：`profile / life_stage / related_story` | 0.8163 → **0.9300**（+11.37pp） |
| [**interview-closeout**](agent/skills/interview-closeout/SKILL.md) | OpenClaw Agent Loop；按 Story / Contributor mode 限定 Evidence Search | 0.7891 → **0.9500**（+16.09pp） |
| [**story-completion**](agent/skills/story-completion/SKILL.md) | OpenClaw Agent Loop；检索当前 Story 历史证据，验证 blocking gaps | 0.7426 → **0.9500**（+20.74pp） |
| [**story-generation**](agent/skills/story-generation/SKILL.md) | OpenClaw Agent Loop；可检索 Transcript / Memory / Contributor / Era，再生成或 revision | 0.7868 → **0.9600**（+17.32pp） |
| [**interview-observer**](agent/skills/interview-observer/SKILL.md) | 单次 local inference，**1 attempt / 0 Tool Call**；Backend 预取证据 | 0.8157 → **0.9400**（+12.43pp） |

### 3.3 Benchmark

**NVIDIA SkillEvaluator Tier 3 项目自测：**

- **5 个 Skill**
- **49 个 Case**
- **196 次 Attempt**
- **196 / 196 成功执行**
- With Skill 相比 Without Skill：**约 +11% ～ +21%**
- Independent Judge：`step-5-preview`

详细结果：[NVIDIA SkillEvaluator Tier 3 正式评测报告](docs/07-reports/skills/tier3/2026-09-28/NVIDIA_SKILL_TIER3_REPORT.md)

**Realtime Interview Benchmark：**

> Realtime-only → + `interview-coach` + NeMo Retriever，**下一问综合质量提升 55%**。

---

## 4. 证据链：让 Agent 会写，但不能乱写

```text
Transcript
   ↓
Story Memory / Summary
   ↓
Completion / Gaps
   ↓
Story Document
```

- SQLite 是业务 **Source of Truth**；
- NeMo Retriever 是可重建的检索层；
- 主人公 Transcript、第三方 Contributor、公共 Era Context 分离；
- 第三方证词不能自动写成主人公亲历；
- 当前明确纠正优先于历史记忆、摘要和旧稿；
- Agent Proposal 必须经过 Backend Validator 后才能落库。

---

## 5. NVIDIA / DGX Spark 技术栈与模型优化

| 技术 / 模型 | 作用 |
|---|---|
| **NVIDIA DGX Spark** | 全本地运行平台 |
| **NemoClaw / OpenClaw** | 会后 Agent Runtime、Agent Loop、Skills 执行 |
| **NeMo Retriever** | Transcript / Story Memory / Contributor / Era 检索 |
| **NeMo Agent Toolkit (NAT)** | Evaluation / Regression / Profiler / Trace |
| **NVIDIA SkillEvaluator** | With Skill / Without Skill、Tier 1 / 2 / 3 评测 |
| **Qwen3.6-35B-A3B-NVFP4** | 本地 Text / Agent / Writing |
| **Qwen3-8B** | 本地低延迟 Interview Coach |
| **Step-Audio-2-mini** | 本地 Realtime Voice |
| **step-5-preview** | SkillEvaluator 独立评审模型 |

### 模型与 Runtime 优化

- Realtime / Coach / Agent **按任务拆模型**，避免一个大模型同时承担所有职责；
- Agent 固定 Context 由 Backend 预取，减少无意义 Tool Round Trip；
- Evidence Search 只在上下文不足或存在冲突时调用；
- Retrieval 采用 source allowlist 和 bounded result；
- Agent 最多 3 attempts，支持 runtime retry、validation repair、format repair；
- Qwen3.6 使用 NVIDIA NVFP4 路线适配 DGX Spark；
- NAT / SkillEvaluator 与产品 Runtime 分离，不增加用户主链延迟。

---

## 6. DGX Spark 部署

全部服务运行在 Spark 本地：

| Runtime | Endpoint |
|---|---|
| Text / Agent | `http://127.0.0.1:8000/v1` |
| Interview Coach | `http://127.0.0.1:8001/v1` |
| Step-Audio-2-mini | `ws://127.0.0.1:8092/realtime` |
| NeMo Retriever | `http://127.0.0.1:7670` |

```bash
git clone https://github.com/gwh7078/life-interview-NVDA.git
cd life-interview-NVDA

cp deploy/spark/env.example deploy/spark/.env

bash deploy/spark/check-env.sh
bash deploy/spark/setup.sh
bash deploy/spark/start.sh
bash deploy/spark/verify.sh
```

仓库负责 Backend / Web、SQLite、Agent Task Contract、Skills、Retriever collections / Era index、NemoClaw / OpenClaw route / policy、Technical Observer 与验收；已运行的本地 Text Model 直接被 Agent Runtime 复用，不启动第二份模型。

完整部署说明：[Spark Deployment Reference](docs/04-nvidia/spark/README.md)

---

## 7. 项目完整性

已实现：

```text
Onboarding / 人生地图
→ Story Create / Continue
→ Realtime Voice Interview
→ External Contributor
→ Transcript
→ Closeout / Story Memory
→ Completion / Gaps
→ Story Generation / Revision
→ Book / PDF
```

同时具备：

- Evidence Retrieval / Era Context；
- Agent Task Runtime / Formal Skills；
- SkillEvaluator / NAT / Technical Observer；
- Demo Auth、分享链接、版本化 Story Document；
- DGX Spark 全本地真人全链验收。

---

## 8. 技术证据

- [整体架构](docs/ARCHITECTURE.md)
- [Agent Runtime / Tool Loop](docs/AGENT_RUNTIME.md)
- [Realtime / Coach](docs/REALTIME.md)
- [SkillEvaluator 最终审查摘要](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)
- [DGX Spark 最终运行验证](docs/07-reports/spark-deployment-evidence-2026-09-29.md)
