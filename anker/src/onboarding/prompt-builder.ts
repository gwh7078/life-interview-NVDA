import type { OnboardingCloseoutContext, OnboardingPromptReferences, OnboardingSourceReference } from './types.js';
import { yearFromStoredDate } from './years.js';

export interface BuiltOnboardingCloseoutPrompt {
  prompt: { system: string; user: string };
  references: OnboardingPromptReferences;
}

function referenceKey(reference: OnboardingSourceReference): string {
  return `${reference.session_id}\u0000${reference.message_id}`;
}

/** Maps database identifiers to opaque aliases before any Transcript content reaches the model. */
export function buildOnboardingCloseoutPrompt(context: OnboardingCloseoutContext): BuiltOnboardingCloseoutPrompt {
  const sourceReferences = new Map<string, OnboardingSourceReference>();
  let nextSourceNumber = 1;
  const interviews = context.transcripts.map((session, index) => {
    const transcript: Array<{ role: 'user'; source_ref: string; text: string } | { role: 'assistant'; text: string }> = [];
    for (const message of session.messages) {
      const text = message.text.trim();
      if (!text) continue;
      if (message.role !== 'user') {
        transcript.push({ role: 'assistant', text });
        continue;
      }
      const reference = { session_id: session.sessionId, message_id: message.message_id };
      const alias = `source_${nextSourceNumber++}`;
      sourceReferences.set(alias, reference);
      transcript.push({ role: 'user', source_ref: alias, text });
    }
    return { interview_number: index + 1, transcript };
  });
  const system = [
    '你是人生采访局的首次建档整理器。采访已经结束；只根据提供的历次建档访谈 Transcript 整理人生档案、人生阶段和未来可继续采访的 Story。',
    '忠实保留用户明确的更正、近似时间与不确定表达。不要根据年龄、性别、职业常识或其他背景推断用户没有说过的个人事实。',
    '输入中的 current_profile 是现有档案值，仅供识别和避免无意丢失信息的未核实上下文；它不是访谈证据，不能据此生成或支持任何候选字段。所有非空 Profile 候选都必须由 Transcript 用户发言直接支持。',
    'Profile 的每个字段都输出 {value, source_refs}。没有 Transcript 依据时 value 用 null 且 source_refs 用空数组；姓名必填，必须由用户发言直接支持。gender 只有在用户明确自我认同时才填写，绝不根据姓名、声音、关系称谓或其他线索推断。',
    'profile_summary 是“人生概况 Facts”，不是人生时间线摘要。只保留 3–6 个跨阶段仍有价值的明确事实，例如教育背景、家庭构成、长期职业/技能背景、稳定身份或其他基础事实；用简洁事实句表达。不要按“后来、之后、随后、毕业后、工作几年后”复述 Life Stage 顺序，也不要把各阶段标题重新串成一段人生经历。current_status 只写当前状态，避免在 profile_summary 里重复展开。',
    '生日只整理为 birth_year（整数年份或 null）；不要输出月日，也不要根据 current_profile 推断或补出访谈里没说的生日年份。',
    '人生阶段通常以 4–8 个为目标，但应服从访谈证据；经历较少或复杂时可以少于或多于这个数量，不得拆出没有依据的阶段。Life Stage 表示一段相对持续稳定的环境、身份、角色或生活结构；学校体系、城市、工作/角色、家庭状态、居住环境或重要身份发生明显变化时可形成边界。不要仅因为都属于“求学”就把跨度很大、环境明显不同的时期压成一个超级阶段，也不要机械规定小学、初中、高中必须各拆一段。每个阶段只列标题、start_year、end_year 和直接支持它的 source_refs，不要生成阶段 summary 或 date_precision。start_year 为整数年份或 null；end_year 为整数年份、表示仍在持续的 now，或表示未知的 null。各阶段可以重叠，缺少年份或年份顺序不确定都不是拒绝理由；不要推断精确月份、日期或年代。',
    '每个纳入的人生阶段必须至少有一个具体、可在未来继续采访的 Story。Story 是一件可以独立叙述和命名的事件或经历，不是整个多年阶段的容器；同一 Life Stage 可以有多个 Story。不要创建“我的求学生涯”“从小学到大学的学习生活”这类吞并多年独立事件的超级 Story；如果时间、场景或核心事件明显不同，应拆为独立 Story Seed。Story 只作为待采访线索，不要求现在已经完整，不要写成完整回忆录；每条 story 的 status 固定为 pending，并由用户发言来源直接支持。',
    'source_refs 只能使用 Transcript 用户消息旁提供的 source_ref（例如 source_1），不得引用 assistant 发言、改写或编造别名。可以将同一来源用于多个直接相关字段。',
    '只输出 schema 要求的结构化结果，不要复述 Transcript、输出推理过程或额外解释。',
  ].join('\n');
  return {
    prompt: {
      system,
      user: JSON.stringify({
        current_profile: {
          name: context.profile.name,
          birth_year: yearFromStoredDate(context.profile.birthDate),
          gender: context.profile.gender,
          birth_place: context.profile.birthPlace,
          current_location: context.profile.currentLocation,
          current_status: context.profile.currentStatus,
          profile_summary: context.profile.profileSummary,
        },
        interviews,
      }),
    },
    references: { sourceReferences },
  };
}

export function restoreOnboardingSourceReferences(
  aliases: string[],
  references: OnboardingPromptReferences,
): OnboardingSourceReference[] {
  return aliases.map((alias) => references.sourceReferences.get(alias) ?? {
    session_id: '',
    message_id: alias,
  });
}

export function sourceReferenceAliasExists(alias: string, references: OnboardingPromptReferences): boolean {
  return references.sourceReferences.has(alias);
}
