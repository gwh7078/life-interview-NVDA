import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { interviewSessions, stories } from '../../db/schema.js';
import { closeoutResultSchema, parseTranscript } from '../../db/transcript.js';
import type { StoryGenerationTranscriptMessage } from './types.js';

/**
 * Returns only the user messages explicitly cited when this Story was created from another Story's Closeout.
 * This preserves the side-Story's original evidence without importing the source Session's unrelated conversation.
 */
export function loadStoryCreationEvidenceMessages(
  databasePath: string | undefined,
  ownerId: string,
  storyId: string,
): StoryGenerationTranscriptMessage[] {
  const connection = createDatabase(databasePath);
  try {
    const story = connection.db.select({
      createdSourceSessionId: stories.createdSourceSessionId,
    }).from(stories).where(and(
      eq(stories.userId, ownerId),
      eq(stories.storyId, storyId),
    )).get();
    if (!story?.createdSourceSessionId) return [];

    const session = connection.db.select({
      sessionId: interviewSessions.sessionId,
      transcriptJson: interviewSessions.transcriptJson,
      closeoutResultJson: interviewSessions.closeoutResultJson,
    }).from(interviewSessions).where(and(
      eq(interviewSessions.userId, ownerId),
      eq(interviewSessions.sessionId, story.createdSourceSessionId),
      eq(interviewSessions.sourceType, 'subject'),
    )).get();
    if (!session?.closeoutResultJson) return [];

    let closeout: ReturnType<typeof closeoutResultSchema.parse>;
    try {
      closeout = closeoutResultSchema.parse(JSON.parse(session.closeoutResultJson));
    } catch {
      return [];
    }
    const source = closeout.new_stories?.find((item) => item.story_id === storyId);
    if (!source || source.source_message_ids.length === 0) return [];

    const sourceIds = new Set(source.source_message_ids);
    let transcript: ReturnType<typeof parseTranscript>;
    try {
      transcript = parseTranscript(session.transcriptJson);
    } catch {
      return [];
    }

    return transcript
      .filter((message) => message.role === 'user' && sourceIds.has(message.message_id))
      .map((message) => ({
        sessionId: session.sessionId,
        messageId: message.message_id,
        role: message.role,
        text: message.text,
        timestamp: message.timestamp,
      }));
  } finally {
    connection.close();
  }
}
