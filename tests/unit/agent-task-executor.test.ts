import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentResultFormatError,
  NemoClawAgentTaskExecutor,
  NemoClawOpenClawAttemptRunner,
  type AgentAttemptRequest,
  type AgentAttemptResult,
  type AgentTaskAttemptRunner,
} from '../../agent/runtime/nemoclaw-task-executor.js';
import { CommandExecutionError, type CommandRunner } from '../../agent/runtime/command-runner.js';
import type { AgentTaskExecutionRequest } from '../../src/agent-tasks/ports/agent-task-executor.js';

function taskRequest(): AgentTaskExecutionRequest {
  return {
    runId: 'run-1',
    ownerId: 'user-1',
    taskType: 'story.completion',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    contextVersion: 'v1',
    skill: 'story-completion',
    skillVersion: 'v1',
    modelProfile: 'reasoning-fast',
    executionPolicy: {
      maxAttempts: 3,
      timeoutMs: 1_000,
      dynamicTools: [],
      allowFormatRepair: true,
    },
    payload: {
      title: '秘密故事',
      agent_memory: '这是不应该出现在 CLI 参数中的完整采访内容',
      stage_title: '学生时期',
      current_status: 'interviewing',
      previous_gaps: [],
      blocked_directions: [],
    },
    validateOutput(output) {
      const value = output as { status?: unknown; gaps?: unknown };
      if (value.status !== 'interviewing' || !Array.isArray(value.gaps)) {
        throw new Error('invalid completion output');
      }
      return output;
    },
  };
}

class CaptureRunner implements CommandRunner {
  command = '';
  args: string[] = [];
  stdin = '';

  async run(command: string, args: string[], _timeoutMs: number, stdin?: string) {
    this.command = command;
    this.args = args;
    this.stdin = stdin ?? '';
    return {
      stdout: 'trace\nLIFE_INTERVIEW_RESULT {"status":"interviewing","gaps":[]}\n',
      stderr: '',
    };
  }
}

test('AttemptRunner injects fixed Context through stdin and performs zero dynamic Tool calls', async () => {
  const runner = new CaptureRunner();
  const attempts = new NemoClawOpenClawAttemptRunner({
    sandboxName: 'life-interview-agent',
    provider: 'stepfun',
    models: { 'reasoning-fast': 'step-test-model' },
  }, runner);

  const result = await attempts.run({
    task: taskRequest(),
    attemptNumber: 1,
    mode: 'normal',
  });

  assert.equal(runner.command, 'nemoclaw');
  assert.ok(runner.args.includes('agent'));
  assert.ok(runner.args.includes('--message-file'));
  assert.ok(runner.args.includes('-'));
  assert.ok(runner.args.includes('--model'));
  assert.ok(runner.args.includes('step-test-model'));
  assert.equal(runner.args.some((arg) => arg.includes('完整采访内容')), false);
  assert.equal(runner.args.some((arg) => arg.includes('get_task_context')), false);
  assert.ok(runner.stdin.includes('完整采访内容'));
  assert.ok(runner.stdin.includes('Do not call a Tool to reload this fixed Context.'));
  assert.equal(result.toolCallCount, 0);
  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
});

class SequenceAttemptRunner implements AgentTaskAttemptRunner {
  requests: AgentAttemptRequest[] = [];

  constructor(private readonly outcomes: Array<AgentAttemptResult | Error>) {}

  async run(request: AgentAttemptRequest): Promise<AgentAttemptResult> {
    this.requests.push(request);
    const outcome = this.outcomes[this.requests.length - 1];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error('missing fake outcome');
    return outcome;
  }
}

function okAttempt(output: unknown): AgentAttemptResult {
  return {
    output,
    runtime: { runtime: 'nemoclaw-openclaw', latencyMs: 1 },
    toolCallCount: 0,
  };
}

test('TaskExecutor owns runtime retry and succeeds within one logical Agent Run', async () => {
  const attempts = new SequenceAttemptRunner([
    new CommandExecutionError('timeout', 'AGENT_RUNTIME_TIMEOUT'),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);

  const result = await executor.execute(taskRequest());
  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(attempts.requests.length, 2);
  assert.equal(attempts.requests[0]?.mode, 'normal');
  assert.equal(attempts.requests[1]?.mode, 'runtime_retry');
});

test('TaskExecutor uses format repair only after final-result formatting failure', async () => {
  const attempts = new SequenceAttemptRunner([
    new AgentResultFormatError('AGENT_RESULT_INVALID', 'bad json', '{"status":'),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);

  const result = await executor.execute(taskRequest());
  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(attempts.requests.length, 2);
  assert.equal(attempts.requests[1]?.mode, 'format_repair');
  assert.match(attempts.requests[1]?.repairFeedback ?? '', /AGENT_RESULT_INVALID/);
});

test('TaskExecutor converts registered-schema failure into format repair', async () => {
  const attempts = new SequenceAttemptRunner([
    okAttempt({ status: 'broken', gaps: [] }),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);

  const result = await executor.execute(taskRequest());
  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(attempts.requests[1]?.mode, 'format_repair');
});
