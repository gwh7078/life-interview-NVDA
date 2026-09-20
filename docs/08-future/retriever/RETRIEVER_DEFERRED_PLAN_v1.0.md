# NeMo Retriever Deferred Integration Plan v1.0

> Status: **Future / Deferred**
>
> 当前 Phase 2B 不做正式产品集成。

## 1. 当前决定

NeMo Retriever 适合后续承担长期检索能力，但当前优先级低于正式 Agent Runtime E2E、Retry / Repair 与模型评测。

因此：

- 当前 Product Workflow 不依赖 Retriever；
- 当前 Realtime 主链路不依赖 Retriever；
- 当前不为了 Retriever 修改 Task Contract；
- 已有部署 / Smoke 资料继续保留。

## 2. 数据职责

### SQLite

永远是 Source of Truth，保存 Profile、Life Stage、Story、Session、Full Transcript、Summary、Story Agent Memory、Gaps、Documents 与 Contributor data。

### Retriever

未来是 Derived Search Index，保存可重建的 Transcript chunks、embedding、metadata 与 searchable representation。

Retriever 丢失时必须能够从 SQLite 重建。

## 3. 写入原则

未来：

```text
Transcript successfully persisted
        |
        v
Async Retriever Index Job
```

Retriever 索引失败不允许回滚已保存 Transcript。

建议状态：

```text
pending
indexing
indexed
failed
```

## 4. 读取原则：条件式，而不是固定式

Retriever / Memory Search 未来不作为每次 Closeout 的固定前处理。

标准模式：

```text
Backend 预取固定 Context
↓
Agent 判断
├─ 信息足够 → 直接完成
└─ 当前任务出现历史疑点
   ↓
   memory_search
   ↓
   少量高相关历史证据
   ↓
   同一个 Agent Run 继续判断
```

典型触发：

- 引用以前说过的内容；
- 人物身份无法判断；
- 当前陈述与长期记忆冲突；
- 疑似新 Story 与已有 Story 重复；
- 时间 / 地点 / 人物关系异常。

## 5. Tool Contract 原则

未来正式访问应经过 Backend / scoped tool / RetrieverAdapter。

浏览器和小程序不直接连接 Retriever。

`memory_search` 应：

- owner scoped；
- resource scoped；
- run scoped；
- 短期 token；
- audit log；
- 返回小 Top-K；
- 带 session/message source metadata；
- 不返回整个人生历史。

## 6. 与 Agent Memory 的关系

二者不互相替代：

- **Agent Memory**：压缩后的长期工作记忆，默认快速进入采访 / Completion 上下文；
- **Retriever**：只有需要细节时，从原始历史证据按需 Recall。

原则：

> 默认先用 Agent Memory，出现疑点再检索原始历史。

## 7. 证据优先级

当前 Transcript 是当前直接证据。

Retriever 找到的历史 Transcript 是补充证据。

如果用户当前明确纠正旧说法：

> 当前明确纠正优先于旧历史陈述。

## 8. Future Integration Order

1. 稳定 Retriever 服务；
2. RetrieverAdapter；
3. Transcript async indexing；
4. scoped `memory_search` contract；
5. Interview Closeout 条件式调用试验；
6. Realtime Slow Agent integration；
7. recall quality / latency / unnecessary-search benchmark；
8. 根据真实效果决定是否扩大使用范围。
