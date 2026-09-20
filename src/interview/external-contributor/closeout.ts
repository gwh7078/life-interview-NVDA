import { createDatabase } from '../../db/client.js';
import { nowUtcIso } from '../../db/time.js';
import { parseTranscript } from '../../db/transcript.js';
import type { CloseoutModelConfig } from '../llm-provider.js';
import { DirectTextModelProvider, type TextModelProvider } from '../../providers/text-model-provider.js';
import { StoryShareRepository } from '../../repositories/story-share-repository.js';

const CONTRIBUTOR_SUMMARY_MAX_LENGTH = 400;
const EXTERNAL_CONTRIBUTOR_CLOSEOUT_MAX_ATTEMPTS = 3;

const contributorSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: CONTRIBUTOR_SUMMARY_MAX_LENGTH },
  },
} as const;

function asSummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('EXTERNAL_CONTRIBUTOR_CLOSEOUT_INVALID');
  }
  const summary = (value as Record<string, unknown>).summary;
  if (typeof summary !== 'string'
    || !summary.trim()
    || summary.trim().length > CONTRIBUTOR_SUMMARY_MAX_LENGTH) {
    throw new Error('EXTERNAL_CONTRIBUTOR_CLOSEOUT_INVALID');
  }
  return summary.trim();
}

function claimExternalContributorCloseout(
  databasePath: string | undefined,
  userId: string,
  sessionId: string,
): 'claimed' | 'completed' {
  const connection = createDatabase(databasePath);
  try {
    const now = nowUtcIso();
    const claimed = connection.sqlite.prepare(`
      UPDATE interview_sessions
      SET closeout_status = 'processing', closeout_result_json = NULL, updated_at = ?
      WHERE session_id = ?
        AND user_id = ?
        AND source_type = 'external_contributor'
        AND status = 'ended'
        AND closeout_status IN ('pending', 'failed')
    `).run(now, sessionId, userId);
    if (claimed.changes === 1) return 'claimed';

    const row = connection.sqlite.prepare(`
      SELECT closeout_status AS closeoutStatus
      FROM interview_sessions
      WHERE session_id = ?
        AND user_id = ?
        AND source_type = 'external_contributor'
      LIMIT 1
    `).get(sessionId, userId) as { closeoutStatus: string } | undefined;
    if (row?.closeoutStatus === 'completed') return 'completed';
    if (row?.closeoutStatus === 'processing') {
      throw new Error('EXTERNAL_CONTRIBUTOR_CLOSEOUT_ALREADY_PROCESSING');
    }
    throw new Error('EXTERNAL_CONTRIBUTOR_SESSION_NOT_READY');
  } finally {
    connection.close();
  }
}

export function markExternalContributorSessionCloseout(
  databasePath: string | undefined,
  userId: string,
  sessionId: string,
  status: 'processing' | 'completed' | 'failed',
  result?: Record<string, unknown>,
): void {
  const connection = createDatabase(databasePath);
  try {
    connection.sqlite.prepare(`
      UPDATE interview_sessions
      SET closeout_status = ?, closeout_result_json = ?, updated_at = ?
      WHERE session_id = ? AND user_id = ? AND source_type = 'external_contributor'
    `).run(status, result ? JSON.stringify(result) : null, nowUtcIso(), sessionId, userId);
  } finally {
    connection.close();
  }
}

export async function runExternalContributorCloseout(input: {
  databasePath?: string;
  userId: string;
  sessionId: string;
  config: CloseoutModelConfig;
  textModelProvider?: TextModelProvider;
}): Promise<void> {
  const claimed = claimExternalContributorCloseout(input.databasePath, input.userId, input.sessionId);
  if (claimed === 'completed') return;

  const connection = createDatabase(input.databasePath);
  let session: {
    sourceShareId: string;
    storyId: string;
    transcriptJson: string;
  } | undefined;
  try {
    session = connection.sqlite.prepare(`
      SELECT
        source_share_id AS sourceShareId,
        story_id AS storyId,
        transcript_json AS transcriptJson
      FROM interview_sessions
      WHERE session_id = ?
        AND user_id = ?
        AND source_type = 'external_contributor'
        AND source_share_id IS NOT NULL
        AND story_id IS NOT NULL
      LIMIT 1
    `).get(input.sessionId, input.userId) as typeof session;
  } finally {
    connection.close();
  }
  if (!session) {
    markExternalContributorSessionCloseout(input.databasePath, input.userId, input.sessionId, 'failed', {
      source_type: 'external_contributor',
      error: 'EXTERNAL_CONTRIBUTOR_SESSION_NOT_FOUND',
    });
    throw new Error('EXTERNAL_CONTRIBUTOR_SESSION_NOT_FOUND');
  }

  try {
    const transcript = parseTranscript(session.transcriptJson);
    if (!transcript.some((message) => message.role === 'user' && message.text.trim())) {
      const share = new StoryShareRepository(input.databasePath)
        .findByShareIdForUser(input.userId, session.sourceShareId);
      if (!share || share.storyId !== session.storyId) throw new Error('EXTERNAL_CONTRIBUTOR_SHARE_NOT_FOUND');
      markExternalContributorSessionCloseout(input.databasePath, input.userId, input.sessionId, 'completed', {
        source_type: 'external_contributor',
        relationship: share.relationship,
        summary: share.contributorSummary,
        no_new_user_content: true,
      });
      return;
    }

    const transcriptText = transcript
      .map((message) => `${message.role === 'user' ? '受访者' : '采访官'}：${message.text}`)
      .join('\n');
    const provider = input.textModelProvider ?? new DirectTextModelProvider();
    const shares = new StoryShareRepository(input.databasePath);
    let lastError: unknown;

    for (let attempt = 1; attempt <= EXTERNAL_CONTRIBUTOR_CLOSEOUT_MAX_ATTEMPTS; attempt += 1) {
      const share = shares.findByShareIdForUser(input.userId, session.sourceShareId);
      if (!share || share.storyId !== session.storyId) throw new Error('EXTERNAL_CONTRIBUTOR_SHARE_NOT_FOUND');

      try {
        const result = await provider.complete({
          system: `你是一名严谨的传记资料整理员。你的任务是维护“同一个外部受访者”的持续采访摘要。
只记录该受访者自己明确表达的记忆、观察、感受和不确定性。
旧摘要是这个受访者此前通过同一个分享链接讲过的内容；本次 Transcript 是最新补充。
保留仍然有效的重要旧信息，吸收本次新增信息；如果本次明确纠正自己之前的说法，以最新说法为准，并保留必要的不确定性。
不要把采访官问题写成事实，不要替主人公或受访者裁决争议，不要补充输入之外的事实。
最终摘要必须控制在 ${CONTRIBUTOR_SUMMARY_MAX_LENGTH} 个字符以内，优先保留后续采访最需要知道的人物、事件、关系、关键细节、明确纠正和不确定性。
输出应当足够完整，使下一次语音采访无需读取旧 Transcript 也能自然接续。仅输出 Schema 要求的 JSON。`,
          user: JSON.stringify({
            relationship: share.relationship,
            previous_contributor_summary: share.contributorSummary || null,
            current_transcript: transcriptText,
          }),
        }, {
          ...input.config,
          maxOutputTokens: Math.min(input.config.maxOutputTokens ?? 1024, 1024),
          structuredOutput: {
            name: 'external_contributor_summary',
            schema: contributorSummarySchema as unknown as Record<string, unknown>,
          },
        });
        const summary = asSummary(result.output);
        const closeoutResult = {
          source_type: 'external_contributor',
          relationship: share.relationship,
          summary,
          model: result.model,
          latency_ms: result.latencyMs,
          attempts: attempt,
        };
        const applied = shares.applyContributorSummary({
          userId: input.userId,
          shareId: share.shareId,
          sessionId: input.sessionId,
          expectedUpdatedAt: share.updatedAt,
          summary,
          closeoutResult,
        });
        if (applied === 'applied') return;
        if (applied === 'missing') throw new Error('EXTERNAL_CONTRIBUTOR_SHARE_NOT_FOUND');
        lastError = new Error('EXTERNAL_CONTRIBUTOR_SUMMARY_STALE');
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('EXTERNAL_CONTRIBUTOR_CLOSEOUT_FAILED');
  } catch (error) {
    markExternalContributorSessionCloseout(input.databasePath, input.userId, input.sessionId, 'failed', {
      source_type: 'external_contributor',
      error: error instanceof Error ? error.message : 'EXTERNAL_CONTRIBUTOR_CLOSEOUT_FAILED',
    });
    throw error;
  }
}
