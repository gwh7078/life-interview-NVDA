import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { stories, storyStatuses } from '../../db/schema.js';
import { nowUtcIso } from '../../db/time.js';
import { MAX_STORY_GAPS, isStoryGapQuestion } from '../gaps.js';
import type { StoryCompletionOutput, StoryCompletionStatus } from './types.js';

export class StoryCompletionPersistenceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'StoryCompletionPersistenceError';
  }
}

/**
 * Small owner-scoped persistence boundary for Completion.
 * The optional expectedUpdatedAt is an optimistic-lock token only; no stale-state table or retry queue is introduced.
 */
export class StoryCompletionPersistenceRepository {
  constructor(private readonly databasePath?: string) {}

  updateCompletionForUser(
    userId: string,
    storyId: string,
    output: StoryCompletionOutput,
    expectedUpdatedAt?: string,
  ): StoryCompletionOutput | null {
    if (!storyStatuses.includes(output.status)
      || !Array.isArray(output.gaps)
      || output.gaps.length > MAX_STORY_GAPS
      || output.gaps.some((gap) => !isStoryGapQuestion(gap))) {
      throw new StoryCompletionPersistenceError('Story Completion output is invalid.', 'STORY_COMPLETION_OUTPUT_INVALID');
    }

    const gaps = output.gaps.map((gap) => gap.trim());
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const current = tx.select({
          status: stories.status,
          updatedAt: stories.updatedAt,
        }).from(stories).where(and(
          eq(stories.userId, userId),
          eq(stories.storyId, storyId),
        )).get();
        if (!current) return null;

        if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
          throw new StoryCompletionPersistenceError(
            'Story changed while Completion was running; stale evaluation was discarded.',
            'STORY_CHANGED_DURING_COMPLETION',
          );
        }

        const status: StoryCompletionStatus = current.status === 'complete' ? 'complete' : output.status;
        const predicate = expectedUpdatedAt
          ? and(
            eq(stories.userId, userId),
            eq(stories.storyId, storyId),
            eq(stories.updatedAt, expectedUpdatedAt),
          )
          : and(eq(stories.userId, userId), eq(stories.storyId, storyId));
        const result = tx.update(stories).set({
          status,
          gapsJson: JSON.stringify(gaps),
          updatedAt: nowUtcIso(),
        }).where(predicate).run();

        if (result.changes !== 1) {
          throw new StoryCompletionPersistenceError(
            'Story changed while Completion was being persisted; stale evaluation was discarded.',
            'STORY_CHANGED_DURING_COMPLETION',
          );
        }
        return { status, gaps };
      });
    } finally {
      connection.close();
    }
  }
}
