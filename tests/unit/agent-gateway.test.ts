import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandExecutionError, type CommandRunner } from '../../agent/runtime/command-runner.js';
import { NemoClawOpenClawGateway } from '../../agent/runtime/nemoclaw-openclaw-gateway.js';
import type { AgentRunStore } from '../../agent/tracing/agent-run-repository.js';
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
  constructor(private readonly failure?: Error) {}
  async run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.command = command;
    this.args = args;
    if (this.failure) throw this.failure;
    return { stdout: 'trace\nLIFE_INTERVIEW_RESULT {"title":"测试故事","gap_count":2}\n', stderr: '' };
  }
}

const request = {
  runId: 'run-1', userId: 'user-1', agentType: 'story-context-inspector',
  taskType: 'inspect-story-context', resourceType: 'story', resourceId: 'story-1',
};

test('AgentGateway uses nemoclaw exec and records succeeded state', async () => {
  const runs = new FakeRuns();
  const runner = new FakeRunner();
  const gateway = new NemoClawOpenClawGateway({
    sandboxName: 'my-assistant', toolBaseUrl: 'http://10.0.0.5:4175', timeoutMs: 1_000,
  }, new AgentToolTokenService('phase1-test-secret-0123456789-abcdef'), runs, runner);
  const result = await gateway.run(request);
  assert.deepEqual(result.output, { title: '测试故事', gap_count: 2 });
  assert.deepEqual(runs.transitions, ['queued', 'running', 'succeeded']);
  assert.equal(runner.command, 'nemoclaw');
  assert.ok(runner.args.includes('exec'));
  assert.ok(runner.args.includes('openclaw'));
  assert.ok(runner.args.some((arg) => arg.startsWith('LIFE_INTERVIEW_TOOL_TOKEN=')));
});

test('AgentGateway records runtime timeout as failed', async () => {
  const runs = new FakeRuns();
  const runner = new FakeRunner(new CommandExecutionError('timeout', 'AGENT_RUNTIME_TIMEOUT'));
  const gateway = new NemoClawOpenClawGateway({
    sandboxName: 'my-assistant', toolBaseUrl: 'http://10.0.0.5:4175', timeoutMs: 1_000,
  }, new AgentToolTokenService('phase1-test-secret-0123456789-abcdef'), runs, runner);
  await assert.rejects(() => gateway.run(request), /timeout/);
  assert.deepEqual(runs.transitions, ['queued', 'running', 'failed']);
});
