import { z } from 'zod';

const sourceMessageIdsSchema = z.array(z.string().min(1).max(64)).max(12);

export const memoryChangeTypes = ['add', 'correct', 'refine', 'merge', 'remove'] as const;

const memoryChangeSchema = z.object({
  type: z.enum(memoryChangeTypes),
  previous_text: z.string().max(1200)
    .describe('被修改的旧 Agent Memory 原文片段；add 时必须为空字符串。'),
  new_text: z.string().max(1200)
    .describe('写入新版 Agent Memory 的原文片段；remove 时必须为空字符串。'),
  source_message_ids: sourceMessageIdsSchema
    .describe('支持 add/correct/refine/remove 的本轮用户消息 ID；纯去重 merge 可以为空。'),
}).strict();

export const storyCloseoutOutputSchema = z.object({
  current_story: z.object({
    summary: z.string().min(1).max(800)
      .describe('面向用户阅读的当前 Story 短摘要；保留旧事实，吸收本轮新增与纠正，只写有依据的信息。'),
    agent_memory: z.string().min(1).max(8000)
      .describe('面向采访 Agent 的 Story 长期工作记忆；基于旧 Memory 增量更新，默认继承旧信息，只在有依据时修改或删除。'),
    memory_changes: z.array(memoryChangeSchema).max(30)
      .describe('仅供 Closeout 校验的内部 Memory 变更记录；不持久化到 Story，不暴露给前端。'),
    source_message_ids: sourceMessageIdsSchema
      .describe('支持本次摘要或 Agent Memory 更新的当前访谈用户消息 ID；若两者均未变化可为空。'),
  }).strict(),
  new_stories: z.array(z.object({
    title: z.string().min(1).max(80),
    summary: z.string().min(1).max(400)
      .describe('独立 Story Seed 的事实摘要，1–3 句；只保留已提及的核心事件和具体上下文，不要求信息完整。'),
    stage_id: z.string().min(1).max(200)
      .describe('从输入的 life_stages.stage_id 中选择最合适的人生阶段。'),
    source_message_ids: sourceMessageIdsSchema.min(1)
      .describe('直接支持该新故事的当前访谈用户消息 ID。'),
  }).strict()).max(5),
}).strict();

export const storyCloseoutJsonSchema = z.toJSONSchema(storyCloseoutOutputSchema);

export const storyCreationCloseoutOutputSchema = z.object({
  story: z.object({
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(800)
      .describe('面向用户阅读的 Story 短摘要；保持故事骨架，不复述对话；只写有依据的信息。'),
    agent_memory: z.string().trim().min(1).max(8000)
      .describe('面向后续 Interview Agent 的长期工作记忆；根据本轮 Transcript 形成，不写成 Q/A。'),
    source_message_ids: sourceMessageIdsSchema.min(1),
  }).strict(),
}).strict();

export const storyCreationCloseoutJsonSchema = z.toJSONSchema(storyCreationCloseoutOutputSchema);

export type StoryCloseoutOutput = z.infer<typeof storyCloseoutOutputSchema>;
export type StoryCreationCloseoutOutput = z.infer<typeof storyCreationCloseoutOutputSchema>;
