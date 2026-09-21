import { writeDiagnosticLog } from '../../diagnostics/logger.js';
import { diagnosticsContentEnabled, writeDiagnosticSnapshot } from '../../diagnostics/snapshot.js';
import type {
  StoryCompletionContext,
  StoryCompletionOutput,
  StoryCompletionProcessorPort,
  StoryCompletionResultWriter,
} from './types.js';

export interface StoryCompletionContextBuilderPort {
  build(userId: string, storyId: string): Promise<StoryCompletionContext>;
}

/** Coordinates context, bounded evaluation, and persistence without owning DB or closeout behavior. */
export class StoryCompletionService {
  constructor(
    private readonly contextBuilder: StoryCompletionContextBuilderPort,
    private readonly processor: StoryCompletionProcessorPort,
    private readonly writer: StoryCompletionResultWriter,
  ) {}

  async evaluate(userId: string, storyId: string): Promise<StoryCompletionOutput> {
    const context = await this.contextBuilder.build(userId, storyId);
    console.info('[story-completion] evaluate_start', {
      storyId,
      currentStatus: context.currentStatus,
      agentMemoryChars: context.agentMemory.length,
      sessionCount: context.sessionCount,
    });
    writeDiagnosticLog('story-completion', 'info', 'Story completion started.', {
      storyId,
      currentStatus: context.currentStatus,
      agentMemoryChars: context.agentMemory.length,
      sessionCount: context.sessionCount,
    });
    const output = await this.processor.process(context, { userId, storyId });
    console.info('[story-completion] model_output', {
      storyId,
      status: output.status,
      gapCount: output.gaps.length,
    });
    const stored = await this.writer.updateCompletionForUser(userId, storyId, output, context.sourceUpdatedAt);
    console.info('[story-completion] evaluate_complete', {
      storyId,
      status: stored.status,
      gapCount: stored.gaps.length,
      statusChanged: stored.status !== context.currentStatus,
    });
    writeDiagnosticLog('story-completion', 'info', 'Story completion finished.', {
      storyId,
      status: stored.status,
      gapCount: stored.gaps.length,
      statusChanged: stored.status !== context.currentStatus,
    });
    writeDiagnosticSnapshot('story-completion', storyId, {
      status: 'completed',
      story_id: storyId,
      previous_status: context.currentStatus,
      current_status: stored.status,
      agent_memory_chars: context.agentMemory.length,
      session_count: context.sessionCount,
      gap_count: stored.gaps.length,
      ...(diagnosticsContentEnabled() ? {
        content: {
          agent_memory: context.agentMemory,
          gaps: stored.gaps,
        },
      } : {}),
    });
    return stored;
  }
}
