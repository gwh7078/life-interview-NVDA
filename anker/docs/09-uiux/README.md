# UI / UX 设计资料

本目录作为「人生采访局」后续 UI / UX 设计资料的统一沉淀入口。

## 当前视觉基线

- 参考图：[`references/ui-reference-core-v1.webp`](references/ui-reference-core-v1.webp)
- 日期：2026-09-22
- 用途：作为当前 Web UI 重构的**视觉方向基线**，重点覆盖登录、首次建档、Interview 通话、Processing、整理结果、我的人生、Story、成稿与文章阅读等核心页面。

![UI/UX Core Reference](references/ui-reference-core-v1.webp)

## 最重要的使用规则

本项目后续 UI / UX 开发必须区分两个“真相源”：

1. **产品/功能真相源**：当前 `main` 代码 + `docs/product/` 最新产品文档 + 当前真实可运行流程。
2. **视觉真相源**：本目录中的参考图、设计规范、Design Tokens、组件规范与交互稿。

因此：

- 参考图里出现、但现有产品不存在的按钮或功能：**不要实现**。
- 现有产品真实存在、但参考图未展示的功能：**必须保留，并使用同一视觉语言重新设计**。
- 不因视觉稿修改既定业务结构、状态机、数据边界或后端接口。
- Interview 坚持 **Call UI**，不要改成 Chat UI。
- Story 状态保持“资料较少 / 正在完善 / 已可成稿”，不要引入百分比完成度。

## 视觉方向

关键词：

> 暖白、深森林绿、沙金、纸张感、人生档案感、温和纪实感、安静阅读感。

避免：

- 科技蓝紫渐变
- 霓虹 AI 风
- Dashboard / 数据看板感
- 游戏化任务中心
- 大量无意义卡片和悬浮层

## 后续目录约定

后续新增 UI / UX 资料统一放在这里，建议按以下结构维护：

```text
docs/09-uiux/
├── README.md
├── references/      # 视觉参考图 / moodboard / 页面总览
├── design-system/   # Design Tokens / 字体 / 色彩 / 间距 / 组件规范
├── flows/           # 用户流程 / 交互流程 / 状态流
├── screens/         # 页面级高保真 / 页面说明
├── audits/          # UX 审查 / 可用性问题 / 可访问性检查
└── decisions/       # 重要 UI/UX 设计决策
```

Git 不追踪空目录，因此这些子目录在首次有内容时再创建。

## 文件命名建议

- 视觉基线：`ui-reference-<scope>-vX.webp`
- Design System：`DESIGN_SYSTEM_vX.md`
- 页面规范：`SCREEN_<NAME>_vX.md`
- 流程规范：`FLOW_<NAME>_vX.md`
- UX 审查：`UX_AUDIT_<scope>_<date>.md`
- 设计决策：`UIUX_DECISION_<topic>_vX.md`

后续 AI 开发或 UX/UI 设计任务，应先读取本目录 README，再读取与当前页面相关的最新规范。
