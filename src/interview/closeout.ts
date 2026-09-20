
export const STORY_INTERVIEW_COMPLETION_UTTERANCE = '本次先聊到这里，再见。';

export type DraftReadiness = 'needs_followup' | 'short_draft_ready' | 'article_ready';

export interface InterviewReadinessAssessment {
  version: 1;
  draft_readiness: DraftReadiness;
  user_answer_count: number;
  substantive_answer_count: number;
  user_character_count: number;
  covered_dimensions: string[];
  missing_dimensions: string[];
  requires_user_confirmation: true;
  source_refs: string[];
}

const DIMENSIONS = [
  { key: 'anchors', label: '明确的时间、地点与关键人物' },
  { key: 'motivation', label: '参与缘由或触发点' },
  { key: 'process', label: '事情经过' },
  { key: 'scene', label: '至少两个具体场景或动作' },
  { key: 'outcome', label: '结果与外部反馈' },
  { key: 'reflection', label: '感受或后续影响' },
] as const;

const SCENE_PATTERN = /(说|问|走|看|听|拿|坐|站|笑|哭|上台|下台|回去|打车|排练|表演|动作|一句|现场)/;

function coveredDimensionKeys(combined: string, answers: Array<{ text: string }>): string[] {
  const timeIsUncertain = /(不(太)?(记得|确定|知道)|忘了|应该|好像|可能).{0,16}(哪年|哪一?年|时间|年级|小学|初中|高中|大学)|(小学|初中|高中|大学).{0,8}(还是|或者).{0,8}(小学|初中|高中|大学)/.test(combined);
  const hasSpecificTime = /(19|20)\d{2}年|[一二三四五六七八九十\d]+年级|高[一二三]|初[一二三]|大[一二三四]|小学[一二三四五六]/.test(combined);
  const hasPlace = /(学校|公司|家里|现场|教室|操场|篮球场|礼堂|舞台|车站|医院|饭店|办公室)/.test(combined);
  const hasPerson = /(同学|老师|朋友|家人|同事|父亲|母亲|爸爸|妈妈|搭档|伙伴|叫.{2,8}|名字.{2,8})/.test(combined);
  const hasTwoSceneAnswers = answers.filter((message) => SCENE_PATTERN.test(message.text)).length >= 2;
  const checks: Record<(typeof DIMENSIONS)[number]['key'], boolean> = {
    anchors: hasSpecificTime && !timeIsUncertain && hasPlace && hasPerson,
    motivation: /(因为.{2,30}(参加|报名|决定|选择|想|安排|邀请)|为了|报名|被选|老师.*安排|学校.*安排|邀请.*参加|决定.*参加)/.test(combined),
    process: /(开始|后来|然后|接着|当时|准备|排练|进行|到了|上台|发生|做了|去了)/.test(combined),
    scene: hasTwoSceneAnswers,
    outcome: /(最后|结果|结束|成功|完成|通过|失败|夸|评价|反应|掌声|反馈|认可)/.test(combined),
    reflection: /(觉得|感到|紧张|放松|开心|难过|害怕|影响|后来|从此|学会|意识到|印象)/.test(combined),
  };
  return DIMENSIONS.filter((dimension) => checks[dimension.key]).map((dimension) => dimension.key);
}

const END_ONLY = /^(没有(什么)?(要|想)?补(充)?的了|没(什么)?可补的了|没了|先到这(里)?|就到这(里)?|结束(吧|了)?|不聊了|再见)(呀|啊|呢|吧)?[。！!，, ]*$/;

export function isExplicitEndIntent(text: string, previousAssistantText = ''): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/(结束(这次)?(采访|访谈|通话)|今天先到这|先聊到这|先到这里|就到这里|不聊了|下次再聊|挂断|再见)/.test(value)) return true;
  const priorOfferedClosing = /(先到这里|今天先到|到这里|再补|还有.*补充|结束|收尾)/.test(previousAssistantText);
  return priorOfferedClosing && END_ONLY.test(value);
}

export function isAssistantFarewell(text: string): boolean {
  const value = text.trim().replace(/\s+/g, '');
  if (!value || /[？?]/.test(value)) return false;
  return /^本次先聊到这里[，,]?再见[。！!]*$/u.test(value);
}

export function assessInterviewReadiness(
  transcript: Array<{ message_id: string; role: 'user' | 'assistant'; text: string }>,
): InterviewReadinessAssessment {
  const answers = transcript.filter((message) => message.role === 'user' && message.text.trim());
  const substantive = answers.filter((message) => message.text.trim().length >= 10 && !END_ONLY.test(message.text.trim()));
  const combined = substantive.map((message) => message.text).join('\n');
  const coveredKeys = coveredDimensionKeys(combined, substantive);
  const articleReady = substantive.length >= 8
    && combined.length >= 500
    && coveredKeys.length >= 5
    && coveredKeys.includes('scene');
  const shortDraftReady = substantive.length >= 5 && combined.length >= 150 && coveredKeys.length >= 4;
  const draftReadiness: DraftReadiness = articleReady
    ? 'article_ready'
    : shortDraftReady
      ? 'short_draft_ready'
      : 'needs_followup';

  return {
    version: 1,
    draft_readiness: draftReadiness,
    user_answer_count: answers.length,
    substantive_answer_count: substantive.length,
    user_character_count: combined.length,
    covered_dimensions: DIMENSIONS.filter((dimension) => coveredKeys.includes(dimension.key)).map((dimension) => dimension.label),
    missing_dimensions: DIMENSIONS.filter((dimension) => !coveredKeys.includes(dimension.key)).map((dimension) => dimension.label),
    requires_user_confirmation: true,
    source_refs: answers.map((message) => message.message_id),
  };
}
