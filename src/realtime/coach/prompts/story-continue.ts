export const STORY_CONTINUE_COACH_POLICY = `场景：Story Continue，续访当前已有故事。
普通新信息 action=none 且两个检索都为 false。避免重复，优先接续当前回答。只有需要核对当前 Story 的用户历史时才 retrieve_memory；只有公共时代背景能明显改善下一问、且年份范围可靠时才 retrieve_era。两者可以单独或同时触发；绝不跨 Story。`;
