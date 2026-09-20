import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../db/client.js';
import { nowUtcIso } from '../db/time.js';

export const STORY_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const STORY_SHARE_RELATIONSHIPS = [
  'wife',
  'husband',
  'daughter',
  'son',
  'father',
  'mother',
  'sibling',
  'friend',
  'classmate',
  'colleague',
  'other',
] as const;

export type StoryShareRelationship = typeof STORY_SHARE_RELATIONSHIPS[number];

export interface StoryShareLinkRecord {
  shareId: string;
  storyId: string;
  userId: string;
  relationship: string;
  contributorSummary: string;
  status: 'active' | 'revoked';
  expiresAt: string;
  interviewCount: number;
  lastInterviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicStoryShareRecord extends StoryShareLinkRecord {
  storyTitle: string;
  storySummary: string;
  storyStatus: 'pending' | 'interviewing' | 'complete';
  storyGapsJson: string;
  ownerName: string | null;
}

export type ContributorSummaryApplyResult = 'applied' | 'stale' | 'missing';

export interface ExternalContributorSessionState {
  sessionStatus: string;
  closeoutStatus: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function mapRow(row: any): StoryShareLinkRecord {
  return {
    shareId: String(row.shareId),
    storyId: String(row.storyId),
    userId: String(row.userId),
    relationship: String(row.relationship),
    contributorSummary: String(row.contributorSummary ?? ''),
    status: row.status === 'revoked' ? 'revoked' : 'active',
    expiresAt: String(row.expiresAt),
    interviewCount: Number(row.interviewCount ?? 0),
    lastInterviewAt: row.lastInterviewAt == null ? null : String(row.lastInterviewAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function isStoryShareRelationship(value: unknown): value is StoryShareRelationship {
  return typeof value === 'string'
    && (STORY_SHARE_RELATIONSHIPS as readonly string[]).includes(value);
}

export class StoryShareRepository {
  constructor(private readonly databasePath?: string) {}

  createForStory(userId: string, storyId: string, relationship: StoryShareRelationship): {
    token: string;
    link: StoryShareLinkRecord;
  } | null {
    const connection = createDatabase(this.databasePath);
    try {
      const story = connection.sqlite.prepare(
        'SELECT story_id FROM stories WHERE user_id = ? AND story_id = ?',
      ).get(userId, storyId);
      if (!story) return null;

      const shareId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const createdAt = nowUtcIso();
      const expiresAt = new Date(Date.parse(createdAt) + STORY_SHARE_TTL_MS).toISOString();
      connection.sqlite.prepare(`
        INSERT INTO story_share_links (
          share_id, story_id, user_id, token_hash, relationship, contributor_summary,
          status, expires_at, interview_count, last_interview_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '', 'active', ?, 0, NULL, ?, ?)
      `).run(
        shareId,
        storyId,
        userId,
        tokenHash(token),
        relationship,
        expiresAt,
        createdAt,
        createdAt,
      );
      return {
        token,
        link: {
          shareId,
          storyId,
          userId,
          relationship,
          contributorSummary: '',
          status: 'active',
          expiresAt,
          interviewCount: 0,
          lastInterviewAt: null,
          createdAt,
          updatedAt: createdAt,
        },
      };
    } finally {
      connection.close();
    }
  }

  listForStory(userId: string, storyId: string): StoryShareLinkRecord[] {
    const connection = createDatabase(this.databasePath);
    try {
      const rows = connection.sqlite.prepare(`
        SELECT
          share_id AS shareId,
          story_id AS storyId,
          user_id AS userId,
          relationship,
          contributor_summary AS contributorSummary,
          status,
          expires_at AS expiresAt,
          interview_count AS interviewCount,
          last_interview_at AS lastInterviewAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM story_share_links
        WHERE user_id = ? AND story_id = ?
        ORDER BY created_at DESC
      `).all(userId, storyId) as any[];
      return rows.map(mapRow);
    } finally {
      connection.close();
    }
  }

  revokeForUser(userId: string, shareId: string): boolean {
    const connection = createDatabase(this.databasePath);
    try {
      const now = nowUtcIso();
      return connection.sqlite.prepare(`
        UPDATE story_share_links
        SET status = 'revoked', updated_at = ?
        WHERE share_id = ? AND user_id = ? AND status = 'active'
      `).run(now, shareId, userId).changes === 1;
    } finally {
      connection.close();
    }
  }

  findByShareIdForUser(userId: string, shareId: string): StoryShareLinkRecord | null {
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT
          share_id AS shareId,
          story_id AS storyId,
          user_id AS userId,
          relationship,
          contributor_summary AS contributorSummary,
          status,
          expires_at AS expiresAt,
          interview_count AS interviewCount,
          last_interview_at AS lastInterviewAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM story_share_links
        WHERE share_id = ? AND user_id = ?
      `).get(shareId, userId);
      return row ? mapRow(row) : null;
    } finally {
      connection.close();
    }
  }

  resolveTokenIdentity(token: string): { shareId: string; userId: string } | null {
    if (!token || token.length > 256) return null;
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT share_id AS shareId, user_id AS userId
        FROM story_share_links
        WHERE token_hash = ?
        LIMIT 1
      `).get(tokenHash(token)) as { shareId: string; userId: string } | undefined;
      return row ? { shareId: String(row.shareId), userId: String(row.userId) } : null;
    } finally {
      connection.close();
    }
  }

  resolvePublicToken(token: string, now = new Date()): PublicStoryShareRecord | null {
    if (!token || token.length > 256) return null;
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT
          link.share_id AS shareId,
          link.story_id AS storyId,
          link.user_id AS userId,
          link.relationship,
          link.contributor_summary AS contributorSummary,
          link.status,
          link.expires_at AS expiresAt,
          link.interview_count AS interviewCount,
          link.last_interview_at AS lastInterviewAt,
          link.created_at AS createdAt,
          link.updated_at AS updatedAt,
          story.title AS storyTitle,
          story.summary AS storySummary,
          story.status AS storyStatus,
          story.gaps_json AS storyGapsJson,
          owner.name AS ownerName
        FROM story_share_links AS link
        JOIN stories AS story
          ON story.story_id = link.story_id AND story.user_id = link.user_id
        JOIN users AS owner
          ON owner.user_id = link.user_id
        WHERE link.token_hash = ?
        LIMIT 1
      `).get(tokenHash(token)) as any;
      if (!row || row.status !== 'active') return null;
      if (!Number.isFinite(Date.parse(String(row.expiresAt))) || Date.parse(String(row.expiresAt)) <= now.getTime()) {
        return null;
      }
      return {
        ...mapRow(row),
        storyTitle: String(row.storyTitle),
        storySummary: String(row.storySummary ?? ''),
        storyStatus: row.storyStatus,
        storyGapsJson: String(row.storyGapsJson ?? '[]'),
        ownerName: row.ownerName == null ? null : String(row.ownerName),
      };
    } finally {
      connection.close();
    }
  }

  applyContributorSummary(input: {
    userId: string;
    shareId: string;
    sessionId: string;
    expectedUpdatedAt: string;
    summary: string;
    closeoutResult: Record<string, unknown>;
    completedAt?: string;
  }): ContributorSummaryApplyResult {
    const connection = createDatabase(this.databasePath);
    try {
      const completedAt = input.completedAt ?? nowUtcIso();
      return connection.sqlite.transaction(() => {
        const updated = connection.sqlite.prepare(`
          UPDATE story_share_links
          SET contributor_summary = ?,
              interview_count = interview_count + 1,
              last_interview_at = ?,
              updated_at = ?
          WHERE share_id = ? AND user_id = ? AND updated_at = ?
        `).run(
          input.summary,
          completedAt,
          completedAt,
          input.shareId,
          input.userId,
          input.expectedUpdatedAt,
        );
        if (updated.changes !== 1) {
          const exists = connection.sqlite.prepare(
            'SELECT 1 FROM story_share_links WHERE share_id = ? AND user_id = ?',
          ).get(input.shareId, input.userId);
          return exists ? 'stale' : 'missing';
        }

        const sessionUpdated = connection.sqlite.prepare(`
          UPDATE interview_sessions
          SET closeout_status = 'completed',
              closeout_result_json = ?,
              updated_at = ?
          WHERE session_id = ?
            AND user_id = ?
            AND source_type = 'external_contributor'
            AND source_share_id = ?
            AND closeout_status = 'processing'
        `).run(
          JSON.stringify(input.closeoutResult),
          completedAt,
          input.sessionId,
          input.userId,
          input.shareId,
        );
        if (sessionUpdated.changes !== 1) {
          throw new Error('EXTERNAL_CONTRIBUTOR_CLOSEOUT_STATE_CHANGED');
        }
        return 'applied';
      })();
    } finally {
      connection.close();
    }
  }

  findLatestContributorSessionStateForShare(userId: string, shareId: string): ExternalContributorSessionState | null {
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT status AS sessionStatus, closeout_status AS closeoutStatus
        FROM interview_sessions
        WHERE user_id = ?
          AND source_share_id = ?
          AND source_type = 'external_contributor'
        ORDER BY started_at DESC, created_at DESC
        LIMIT 1
      `).get(userId, shareId) as ExternalContributorSessionState | undefined;
      return row ?? null;
    } finally {
      connection.close();
    }
  }

  findLatestFailedSessionForShare(userId: string, shareId: string): string | null {
    const connection = createDatabase(this.databasePath);
    try {
      const row = connection.sqlite.prepare(`
        SELECT session_id AS sessionId
        FROM interview_sessions
        WHERE user_id = ?
          AND source_share_id = ?
          AND source_type = 'external_contributor'
          AND status = 'ended'
          AND closeout_status = 'failed'
        ORDER BY ended_at DESC, updated_at DESC
        LIMIT 1
      `).get(userId, shareId) as { sessionId: string } | undefined;
      return row ? String(row.sessionId) : null;
    } finally {
      connection.close();
    }
  }
}
