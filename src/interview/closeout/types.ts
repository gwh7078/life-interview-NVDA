export interface ValidatedNewStory {
  title: string;
  summary: string;
  stage_id: string;
  source_message_ids: string[];
}

export type ValidatedStoryCloseoutOutput =
  | {
      mode: 'continue';
      current_story: { summary: string; agent_memory: string; source_message_ids: string[] };
      new_stories: ValidatedNewStory[];
    }
  | {
      mode: 'create';
      stage_id: string;
      story: { title: string; summary: string; agent_memory: string; source_message_ids: string[] };
    };
