import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import { runExternalContributorCloseout } from '../../src/interview/external-contributor/closeout.js';
import type { AgentTaskPort, AgentTaskRequestUnion, AgentTaskResultUnion, AgentTaskRunOptions } from '../../src/agent-tasks/index.js';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedDatabase, seedIds } from '../../src/db/seed.js';
import { serializeTranscript } from '../../src/db/transcript.js';
import { StoryShareRepository } from '../../src/repositories/story-share-repository.js';

const directories: string[] = [];

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

class CapturingTasks implements AgentTaskPort {
  request?: AgentTaskRequestUnion;
  options?: AgentTaskRunOptions;

  async run(request: AgentTaskRequestUnion, options: AgentTaskRunOptions = {}): Promise<AgentTaskResultUnion> {
    this.request = request;
    this.options = options;
    return {
      runId: request.runId,
      taskType: request.taskType,
      mode: request.mode,
      schemaVersion: request.schemaVersion,
      output: { summary: '亲友记得主人公那天很早出门。' },
      runtime: { runtime: 'test', skill: 'interview-closeout' },
    } as AgentTaskResultUnion;
  }
}

test('external Contributor receives a share-scoped contributor-only evidence token', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/contributor-evidence-search-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();
  const share = new StoryShareRepository(databasePath)
    .createForStory(seedIds.user, seedIds.firstProject, 'daughter')!.link;
  const sessionId = 'external-contributor-session-evidence';
  const currentTime = '2026-09-20T10:00:00.000Z';
  const transcript = serializeTranscript([{
    message_id: 'contributor-message-1',
    role: 'user',
    text: '我记得那天主人公很早就出门了。',
    timestamp: currentTime,
    provider: 'openclaw',
  }]);
  const sessionConnection = createDatabase(databasePath);
  sessionConnection.sqlite.prepare(`
    INSERT INTO interview_sessions (
      session_id, provider, user_id, story_id, session_type, source_type, source_share_id,
      status, closeout_status, transcript_json, started_at, ended_at, created_at, updated_at
    ) VALUES (?, 'openclaw', ?, ?, 'story', 'external_contributor', ?, 'ended', 'pending', ?, ?, ?, ?, ?)
  `).run(sessionId, seedIds.user, seedIds.firstProject, share.shareId, transcript, currentTime, currentTime, currentTime, currentTime);
  sessionConnection.close();

  const tasks = new CapturingTasks();
  const tokenService = new AgentToolTokenService('external-contributor-test-secret-012345678901234567890');
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId,
    config: { baseUrl: 'http://unused.test', apiKey: 'unused' },
    agentTaskPort: tasks,
    evidenceSearchScriptConfig: { baseUrl: 'http://backend.test', tokenService },
  });

  assert.equal(tasks.request?.mode, 'contributor');
  assert.ok(tasks.options?.scriptContext?.token);
  const payload = tokenService.verify(tasks.options!.scriptContext!.token, {
    tool: 'evidence_search', resourceType: 'agent_evidence_search',
  });
  assert.equal(payload.userId, seedIds.user);
  assert.equal(payload.evidenceSearch?.storyId, seedIds.firstProject);
  assert.equal(payload.evidenceSearch?.shareId, share.shareId);
  assert.equal(payload.evidenceSearch?.currentSessionId, sessionId);
  assert.deepEqual(payload.evidenceSearch?.allowedSourceTypes, ['contributor_transcript']);
});
