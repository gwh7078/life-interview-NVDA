export const STORY_CONTINUE_COACH_POLICY = `场景：Story Continue，续访当前已有故事。
普通新信息 action=none 且 retrieve=false。避免重复，优先接续当前回答。只有当前回答引用过去、可能与过去冲突或确需核对历史时才 retrieve=true，并用一句短中文给 query。只允许查询当前 Story 的主人公事实；绝不跨 Story。`;
