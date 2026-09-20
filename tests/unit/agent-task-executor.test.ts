import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NemoClawOpenClawTaskExecutor } from '../../agent/runtime/nemoclaw-task-executor.js';
import type { CommandRunner } from '../../agent/runtime/command-runner.js';
import type { AgentRunStore } from '../../agent/tracing/agent-run-repository.js';
import { FileAgentTaskContextStore } from '../../agent/tools/task-context-store.js';
import { AgentToolTokenService } from '../../agent/tools/token.js';

class FakeRuns implements AgentRunStore {
  transitions: string[] = [];
  create(): void { this.transitions.push('queued'); }
  markRunning(): void { this.transitions.push('running'); }
  markSucceeded(): void { this.transitions.push('succeeded'); }
  markFailed(): void { this.transitions.push('failed'); }
}

class FakeRunner implements CommandRunner {
  command = '';
  args: string[] = [];

  async run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.command = command;
    this.args = args;
    return {
      stdout: 'trace\nLIFE_INTERVIEW_RESULT {"status":"interviewing","gaps":[]}\n',
      stderr: '',
    };
  }
}

test('NemoClawOpenClawTaskExecutor transports payload through scoped context store, not CLI args', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'life-interview-task-executor-'));
  try {
    const contexts = new FileAgentTaskContextStore(dir);
    const runs = new FakeRuns();
    const runner = new FakeRunner();
    const executor = new NemoClawOpenClawTaskExecutor({
      sandboxName: 'life-interview-agent',
      toolBaseUrl: 'http://10.0.0.5:4175',
      provider: 'stepfun',
      models: { 'reasoning-fast': 'step-test-model' },
      timeoutMs: 1_000,
    }, new AgentToolTokenService('phase2b-test-secret-0123456789-abcdef'), contexts, runs, runner);

    const sensitive = '这是不应该出现在 CLI 参数中的完整采访内容';
    const result = await executor.execute({
      runId: 'run-1',
      ownerId: 'user-1',
      taskType: 'story.completion',
      resource: { type: 'story', id: 'story-1' },
      schemaVersion: 'v1',
      skill: 'story-completion',
      modelProfile: 'reasoning-fast',
      payload: {
        title: '测试故事',
        agent_memory: sensitive,
        stage_title: '学生时期',
        current_status: 'interviewing',
        previous_gaps: [],
        blocked_directions: [],
      },
    });

    assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
    assert.equal(result.runtime.model, 'step-test-model');
    assert.equal(result.runtime.provider, 'stepfun');
    assert.deepEqual(runs.transitions, ['queued', 'running', 'succeeded']);
    assert.equal(runner.command, 'nemoclaw');
    assert.ok(runner.args.includes('openclaw'));
    assert.ok(runner.args.includes('--model'));
    assert.ok(runner.args.includes('step-test-model'));
    assert.equal(runner.args.some((arg) => arg.includes(sensitive)), false);
    assert.equal(contexts.get('run-1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
