import {
  agentTaskRequestEnvelopeSchema,
  agentTaskResultEnvelopeSchema,
  type AgentTaskRequestUnion,
  type AgentTaskResultUnion,
  type ContributorCloseoutTaskInput,
  type OnboardingCloseoutTaskInput,
  type StoryCompletionTaskInput,
  type StoryContinueCloseoutTaskInput,
  type StoryCreateCloseoutTaskInput,
} from '../contracts/index.js';
import { getAgentTaskDefinition } from '../definitions/task-definition-registry.js';
import type { AgentTaskPort } from '../ports/agent-task-port.js';

function firstOnboardingSource(input: OnboardingCloseoutTaskInput): string {
  for (const interview of input.interviews) {
    for (const message of interview.transcript) {
      if (message.role === 'user') return message.source_ref;
    }
  }
  return 'source_1';
}

function firstTranscriptUserMessageId(
  input: StoryCreateCloseoutTaskInput | StoryContinueCloseoutTaskInput | ContributorCloseoutTaskInput,
): string {
  return input.transcript.find((message) => message.role === 'user')?.message_id ?? 'm1';
}

function stubOutput(request: AgentTaskRequestUnion): unknown {
  if (request.taskType === 'onboarding.closeout') {
    const sourceRef = firstOnboardingSource(request.payload);
    const name = request.payload.current_profile.name?.trim() || 'Stub User';
    return {
      profile: {
        name: { value: name, source_refs: [sourceRef] },
        birth_year: { value: null, source_refs: [] },
        gender: { value: null, source_refs: [] },
        birth_place: { value: null, source_refs: [] },
        current_location: { value: null, source_refs: [] },
        current_status: { value: null, source_refs: [] },
        profile_summary: { value: null, source_refs: [] },
      },
      life_stages: [],
    };
  }

  if (request.taskType === 'interview.closeout') {
    if (request.mode === 'story_create') {
      const input = request.payload;
      const sourceId = firstTranscriptUserMessageId(input);
      return {
        story: {
          title: input.target_story_title ?? 'Stub Story',
          summary: 'Stub story summary.',
          agent_memory: 'Stub story working memory.',
          source_message_ids: [sourceId],
        },
      };
    }
    if (request.mode === 'story_continue') {
      const input = request.payload;
      return {
        current_story: {
          summary: input.current_story.summary || 'Stub story summary.',
          agent_memory: input.current_story.agent_memory,
          memory_changes: [],
          source_message_ids: [],
        },
        new_stories: [],
      };
    }
    const input = request.payload;
    const sourceText = input.transcript.find((message) => message.role === 'user')?.text.trim();
    return {
      summary: input.previous_contributor_summary?.trim()
        || sourceText?.slice(0, 400)
        || 'Stub contributor summary.',
    };
  }

  if (request.taskType === 'story.completion') {
    const input: StoryCompletionTaskInput = request.payload;
    return {
      status: input.current_status === 'complete' ? 'complete' : 'interviewing',
      gaps: [],
    };
  }

  if (request.taskType === 'interview.context_hint') {
    return {
      selected_evidence_ids: [],
      possible_conflicts: [],
      interview_hints: [],
    };
  }

  return { content: 'Stub story document.' };
}

export class StubAgentTaskAdapter implements AgentTaskPort {
  async run(request: AgentTaskRequestUnion): Promise<AgentTaskResultUnion> {
    agentTaskRequestEnvelopeSchema.parse(request);
    const definition = getAgentTaskDefinition(request.taskType, request.mode);
    definition.inputSchema.parse(request.payload);
    const output = definition.outputSchema.parse(stubOutput(request));

    const result = {
      runId: request.runId,
      taskType: request.taskType,
      ...(request.mode ? { mode: request.mode } : {}),
      schemaVersion: request.schemaVersion,
      output,
      runtime: {
        runtime: 'stub',
        skill: definition.skill,
        skillVersion: definition.contextVersion,
      },
    } as AgentTaskResultUnion;
    agentTaskResultEnvelopeSchema.parse(result);
    return result;
  }
}
