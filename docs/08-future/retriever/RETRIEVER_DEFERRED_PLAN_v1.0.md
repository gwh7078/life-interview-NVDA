# NeMo Retriever Deferred Integration Plan v1.0

> Status: **Future / Deferred**
>
> 当前 Phase 2A / 2B 第一阶段不做正式产品集成。

## 1. 当前决定

NeMo Retriever 适合后续承担长期检索能力，但当前优先级低于 Agent Task Contract 与核心 Agent Runtime。

因此：

- 当前不让 Product Workflow 依赖 Retriever；
- 当前不让 Realtime 主链路依赖 Retriever；
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

## 4. 读取原则

未来主要用于：

- Realtime Slow System Memory Search；
- Interview 深层历史 Recall；
- 长 Story 历史证据检索；
- Generation 辅助证据检索。

正式访问应经过 Backend / scoped tool / RetrieverAdapter，避免浏览器或小程序直接连接 Retriever。

## 5. 与 Agent Memory 的关系

二者不互相替代：

- **Agent Memory**：压缩后的长期工作记忆，默认快速进入采访 / Completion 上下文。
- **Retriever**：需要细节时从原始历史证据按需 Recall。

## 6. Future Integration Order

1. 稳定 Retriever 服务；
2. RetrieverAdapter；
3. Transcript async indexing；
4. scoped search contract；
5. Slow System integration；
6. recall quality / latency benchmark；
7. 根据真实效果决定是否扩大使用范围。
