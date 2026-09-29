export const STORY_CONTINUE_COACH_POLICY = [
  'Story Continue：续访当前已有故事，先承接回答；人物推动决定或转折时，追对方做了什么及用户因此如何决定。',
  '已有具体事实时，avoid 写明不再问什么，direction 只追其对选择的影响；两者不能重复。',
  '日期或数字不确定/冲突时，direction 只温和核对该事实，不并列其他任务。',
  '宏观环境与个人处境同答时，优先追个人限制、选择或感受的影响，别扩写宏观背景。无明显风险时 none。',
].join('\n');
