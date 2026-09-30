# 人生采访局 · Life Interview

> **7 天，只说话不写字，完成一部约 10 万字个人回忆录。**  
> AI 回忆录记者用“听、问、辨、写”完成持续采访、证据核对、缺口发现和最终成稿。

**DGX Spark：全本地验证通过，支持断网运行。**  
文本 / 智能体、Qwen3-8B 采访教练、Step-Audio-2-mini、NeMo Retriever、NemoClaw / OpenClaw、后端 / Web、SQLite 均已在 NVIDIA DGX Spark GB10 本地运行；断开外部网络后产品主链仍可使用，真人连续语音操作流畅。

---

## 1. 评委评分速览

| 评分项 | 项目得分点 |
|---|---|
| **实用性 / 行业落地 / 技术创新 · 25%** | 用持续语音采访替代“让用户自己写”；快慢系统解决实时自然度与专业追问冲突；证据链避免长访谈事实漂移 |
| **智能体与模型优化技术深度 · 25%** | 6 个正式 Agent Skills；NemoClaw / OpenClaw 智能体执行循环；受限工具调用；NeMo Retriever；结构 / 证据 / 业务规则校验；校验修复 / 格式修复；快慢模型分工 |
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
          判断：是否需要介入？
             │
          ┌──┴──────────┐
          │             │
     故事记忆       时代背景
       检索            检索
          └──────┬──────┘
              生成指导
                 ↓
           采访指导包
                 ↓
           下一轮自然追问
```

关键优化：

- **判断阶段 ≤ 2 秒，采访教练总时限 ≤ 6 秒**；
- 故事记忆 / 时代背景 **按需检索，可并行**；
- 超时、失败或结果过期时全部 **失败放行**，不阻塞语音；
- 实时语音、采访教练、文本 / 智能体使用不同模型与接口；
- 长期证据进入 Retriever，不把全部历史塞回语音模型上下文。

---

## 3. Agent Skills：真正的智能体执行循环、工具调用与运行时

项目有 **6 个正式 Skills**。比赛主线是 5 个业务 Skill；`interview-observer` 是辅助实时观察 Skill。

### 3.1 会后 Agent 执行循环

```text
后端任务路由
      ↓
任务定义
Skill / 模型 / 超时 / 工具白名单
      ↓
NemoClaw / OpenClaw 智能体
      │
      ├─ 可选工具调用：evidence-search
      │      ↓
      │   NeMo Retriever
      │
      ↓
候选结果
      ↓
结构校验 → 证据校验 → 业务规则校验
      │
      ├─ 拒绝 → 校验修复 / 格式修复 → 重试
      │           （最多 3 次）
      ↓
应用写入
```

四个核心会后 Skill 可在需要时调用各自打包的 `scripts/evidence-search.mjs`；后端控制用户、Story、第三方证据通道、来源白名单、令牌、结果数量与来源信息，智能体不能自行扩大检索范围。

### 3.2 Skill 技术实现与实测

| Skill | 运行时 / 执行循环 / 工具调用 | 实测结果 |
|---|---|---:|
| [**interview-coach**](agent/skills/interview-coach/SKILL.md) | 独立低延迟 Runtime；**Gate → 可选 Memory/Era Retrieval → 生成指导**；不走通用 OpenClaw Loop | 下一问综合质量 **+55%** |
| [**onboarding-closeout**](agent/skills/onboarding-closeout/SKILL.md) | OpenClaw 智能体执行循环，最多 3 次尝试；可调用工具：`profile / life_stage / related_story` | 0.8163 → **0.9300**（+11.37pp） |
| [**interview-closeout**](agent/skills/interview-closeout/SKILL.md) | OpenClaw 智能体执行循环；按 Story / 第三方模式限定证据检索 | 0.7891 → **0.9500**（+16.09pp） |
| [**story-completion**](agent/skills/story-completion/SKILL.md) | OpenClaw 智能体执行循环；检索当前 Story 历史证据，验证关键缺口 | 0.7426 → **0.9500**（+20.74pp） |
| [**story-generation**](agent/skills/story-generation/SKILL.md) | OpenClaw 智能体执行循环；可检索访谈原文 / 故事记忆 / 第三方证据 / 时代背景，再生成或修订 | 0.7868 → **0.9600**（+17.32pp） |
| [**interview-observer**](agent/skills/interview-observer/SKILL.md) | 单次本地推理，**1 次尝试 / 0 次工具调用**；后端预取证据 | 0.8157 → **0.9400**（+12.43pp） |

### 3.3 基准评测

**NVIDIA SkillEvaluator Tier 3 项目自测：**

- **5 个 Skill**
- **49 个评测案例**
- **196 次执行尝试**
- **196 / 196 全部成功执行**
- **加载 Skill** 相比 **不加载 Skill**：**约 +11% ～ +21%**
- 独立评审模型：`step-5-preview`

详细结果：[NVIDIA SkillEvaluator Tier 3 正式评测报告](docs/07-reports/skills/tier3/2026-09-28/NVIDIA_SKILL_TIER3_REPORT.md)

**实时采访基准评测：**

> 仅实时模型 → 加入 `interview-coach` + NeMo Retriever，**下一问综合质量提升 55%**。

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

- SQLite 是业务 **真相源**；
- NeMo Retriever 是可重建的检索层；
- 主人公访谈原文、第三方证据、公共时代背景分离；
- 第三方证词不能自动写成主人公亲历；
- 当前明确纠正优先于历史记忆、摘要和旧稿；
- Agent 候选结果 必须经过 Backend Validator 后才能落库。

---

## 5. NVIDIA / DGX Spark 技术栈与模型优化

| 技术 / 模型 | 作用 |
|---|---|
| **NVIDIA DGX Spark** | 全本地运行平台 |
| **NemoClaw / OpenClaw** | 会后智能体运行时、智能体执行循环、Skills 执行 |
| **NeMo Retriever** | Transcript / Story Memory / Contributor / Era 检索 |
| **NeMo Agent Toolkit (NAT)** | 评测 / 回归 / 性能分析 / 轨迹记录 |
| **NVIDIA SkillEvaluator** | 加载 Skill / 不加载 Skill、Tier 1 / 2 / 3 评测 |
| **Qwen3.6-35B-A3B-NVFP4** | 本地 Text / Agent / Writing |
| **Qwen3-8B** | 本地低延迟 Interview Coach |
| **Step-Audio-2-mini** | 本地 Realtime Voice |
| **step-5-preview** | SkillEvaluator 独立评审模型 |

### 模型与运行时优化

- Realtime / Coach / Agent **按任务拆模型**，避免一个大模型同时承担所有职责；
- 智能体固定上下文由后端预取，减少无意义的工具往返调用；
- 证据检索只在上下文不足或存在冲突时调用；
- 检索采用来源白名单和受限结果数量；
- 智能体最多 3 次尝试，支持运行时重试、校验修复和格式修复；
- Qwen3.6 使用 NVIDIA NVFP4 路线适配 DGX Spark；
- NAT / SkillEvaluator 与产品运行时分离，不增加用户主链延迟。

---

## 6. DGX Spark 部署

全部服务运行在 Spark 本地：

| 运行时 | 接口 |
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

仓库负责后端 / Web、SQLite、智能体任务协议、Skills、Retriever 集合 / 时代背景索引、NemoClaw / OpenClaw 路由 / 策略、Technical Observer 与验收；已运行的本地文本模型直接被智能体运行时复用，不启动第二份模型。

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

- 证据检索 / 时代背景；
- 智能体任务运行时 / 正式 Skills；
- SkillEvaluator / NAT / Technical Observer；
- Demo Auth、分享链接、版本化 Story Document；
- DGX Spark 全本地真人全链验收。

---

## 8. 技术证据

- [整体架构](docs/ARCHITECTURE.md)
- [智能体运行时 / 工具调用循环](docs/AGENT_RUNTIME.md)
- [Realtime / Coach](docs/REALTIME.md)
- [SkillEvaluator 最终审查摘要](docs/07-reports/skills/NVIDIA_SKILL_AUDIT.md)
- [DGX Spark 最终运行验证](docs/07-reports/spark-deployment-evidence-2026-09-29.md)
