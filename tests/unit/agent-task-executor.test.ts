import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

function taskRequest(signal?: AbortSignal): AgentTaskExecutionRequest {
  return {
    runId: 'run-1',
    ownerId: 'user-1',
    taskType: 'story.completion',
    resource: { type: 'story', id: 'story-1', version: 'story-version-1' },
    schemaVersion: 'v1',
    contextVersion: 'v1',
    skill: 'story-completion',
    skillVersion: 'v1',
    modelProfile: 'reasoning-fast',
    executionPolicy: {
      maxAttempts: 3,
      timeoutMs: 1_000,
      scriptCapabilities: [],
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
    ...(signal ? { signal } : {}),
    validateOutput(output) {
      const value = output as { status?: unknown; gaps?: unknown };
      if (value.status !== 'interviewing' || !Array.isArray(value.gaps)) {
        throw new Error('invalid completion output');
      }
      return output;
    },
    validationFeedback(error) {
      return [{
        code: 'INVALID_COMPLETION_OUTPUT',
        path: 'status',
        instruction: error instanceof Error ? error.message : '修正 Completion Proposal。',
      }];
    },
  };
}

function scriptTaskRequest(): AgentTaskExecutionRequest {
  const base = taskRequest();
  return {
    ...base,
    taskType: 'interview.closeout',
    mode: 'story_continue',
    skill: 'interview-closeout',
    modelProfile: 'reasoning',
    executionPolicy: {
      ...base.executionPolicy,
      scriptCapabilities: ['memory-search'],
    },
    scriptContext: {
      baseUrl: 'http://host.example:4174',
      token: 'short-lived-secret',
    },
  };
}

class CaptureRunner implements CommandRunner {
  command = '';
  args: string[] = [];
  stdin = '';
  signal?: AbortSignal;

  async run(
    command: string,
    args: string[],
    _timeoutMs: number,
    stdin?: string,
    signal?: AbortSignal,
  ) {
    this.command = command;
    this.args = args;
    this.stdin = stdin ?? '';
    this.signal = signal;
    return {
      stdout: 'trace\nLIFE_INTERVIEW_RESULT {"status":"interviewing","gaps":[]}\n[agents/agent-command] run ended with stopReason=stop\n',
      stderr: 'LIFE_INTERVIEW_RUNTIME openclaw_start_ms=1000\nLIFE_INTERVIEW_RUNTIME openclaw_end_ms=1200 openclaw_exit=0\n',
    };
  }
}

class SequenceCaptureRunner implements CommandRunner {
  inputs: string[] = [];
  private callCount = 0;

  async run(
    _command: string,
    _args: string[],
    _timeoutMs: number,
    stdin?: string,
  ) {
    this.inputs.push(stdin ?? '');
    this.callCount += 1;
    if (this.callCount === 1) return { stdout: 'malformed candidate', stderr: '' };
    return {
      stdout: 'LIFE_INTERVIEW_RESULT {"status":"interviewing","gaps":[]}\n',
      stderr: '',
    };
  }
}

class FailingRunner implements CommandRunner {
  async run(
    _command: string,
    _args: string[],
    _timeoutMs: number,
    _stdin?: string,
    _signal?: AbortSignal,
  ): Promise<never> {
    throw new CommandExecutionError('timeout', 'AGENT_RUNTIME_TIMEOUT', 'provider stderr');
  }
}

test('AttemptRunner preinjects fixed Context and authorizes zero retrieval scripts', async () => {
  const runner = new CaptureRunner();
  const attempts = new NemoClawOpenClawAttemptRunner({
    sandboxName: 'my-assistant',
    provider: 'stepfun',
    models: { 'reasoning-fast': 'step-test-model' },
  }, runner);

  const controller = new AbortController();
  const result = await attempts.run({
    task: taskRequest(controller.signal),
    attemptNumber: 1,
    mode: 'normal',
  });

  assert.equal(runner.command, 'nemoclaw');
  assert.ok(runner.args.includes('exec'));
  assert.ok(runner.args.includes('--stdin'));
  assert.ok(runner.args.some((arg) => arg.includes('openclaw agent "$@" --message-file "$tmp"')));
  assert.ok(runner.args.includes('--model'));
  assert.ok(runner.args.includes('step-test-model'));
  assert.equal(runner.args.some((arg) => arg.includes('完整采访内容')), false);
  assert.ok(runner.stdin.includes('完整采访内容'));
  assert.ok(runner.stdin.includes('Do not run a script to reload this fixed Context.'));
  assert.equal(runner.signal, controller.signal);
  assert.equal(result.execCallCount, 0);
  assert.equal(result.scriptCallCount, 0);
  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
});

test('AttemptRunner exposes only the authorized retrieval script and counts its marker', async () => {
  const runner = new CaptureRunner();
  runner.run = async (
    command: string,
    args: string[],
    timeoutMs: number,
    stdin?: string,
    signal?: AbortSignal,
  ) => {
    runner.command = command;
    runner.args = args;
    runner.stdin = stdin ?? '';
    runner.signal = signal;
    return {
      stdout: 'LIFE_INTERVIEW_RESULT {"status":"interviewing","gaps":[]}',
      stderr: 'LIFE_INTERVIEW_SCRIPT_CALL memory-search\nLIFE_INTERVIEW_SCRIPT_RESULT memory-search result_count=2 latency_ms=37\n',
    };
  };
  const attempts = new NemoClawOpenClawAttemptRunner({ sandboxName: 'my-assistant' }, runner);
  const result = await attempts.run({ task: scriptTaskRequest(), attemptNumber: 1, mode: 'normal' });
  assert.equal(result.scriptCallCount, 1);
  assert.match(runner.stdin, /scripts\/memory-search\.mjs/);
  assert.equal(runner.stdin.includes('short-lived-secret'), false);
  assert.equal(runner.args.some((arg) => arg.includes('LIFE_INTERVIEW_RETRIEVAL_BASE_URL')), true);
});

test('Format Repair removes retrieval authorization from the prompt and command', async () => {
  const runner = new CaptureRunner();
  const attempts = new NemoClawOpenClawAttemptRunner({ sandboxName: 'my-assistant' }, runner);

  await attempts.run({
    task: scriptTaskRequest(),
    attemptNumber: 2,
    mode: 'format_repair',
    repairCandidate: '{"summary":',
  });

  assert.match(runner.stdin, /No retrieval Skill Script is authorized/);
  assert.equal(runner.stdin.includes('memory-search.mjs'), false);
  assert.equal(runner.args.some((arg) => arg.includes('LIFE_INTERVIEW_RETRIEVAL_BASE_URL')), false);
  assert.equal(runner.args.some((arg) => arg.includes('short-lived-secret')), false);
});

test('AttemptRunner records timing diagnostics without task content', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'life-interview-agent-timing-'));
  const diagnosticsPath = path.join(directory, 'timing.jsonl');
  try {
    const runner = new CaptureRunner();
    const attempts = new NemoClawOpenClawAttemptRunner({
      sandboxName: 'my-assistant',
      provider: 'stepfun',
      thinking: 'off',
      diagnosticsPath,
      models: { 'reasoning-fast': 'step-test-model' },
    }, runner);

    await attempts.run({
      task: taskRequest(),
      attemptNumber: 1,
      mode: 'normal',
    });

    assert.ok(runner.args.includes('--thinking'));
    assert.ok(runner.args.includes('off'));
    const timing = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as {
      taskType: string;
      mode: string;
      attemptNumber: number;
      thinking?: string;
      promptBytes: number;
      stdoutBytes: number;
      stderrBytes: number;
      openclawMs?: number;
      hostOverheadMs?: number;
      scriptCallCount: number;
    };
    assert.equal(timing.taskType, 'story.completion');
    assert.equal(timing.mode, 'normal');
    assert.equal(timing.attemptNumber, 1);
    assert.equal(timing.thinking, 'off');
    assert.ok(timing.promptBytes > 0);
    assert.ok(timing.stdoutBytes > 0);
    assert.ok(timing.stderrBytes > 0);
    assert.equal(timing.openclawMs, 200);
    assert.ok((timing.hostOverheadMs ?? 0) >= 0);
    assert.equal(JSON.stringify(timing).includes('完整采访内容'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AttemptRunner records failed timing diagnostics without task content', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'life-interview-agent-failed-timing-'));
  const diagnosticsPath = path.join(directory, 'timing.jsonl');
  try {
    const attempts = new NemoClawOpenClawAttemptRunner({
      sandboxName: 'my-assistant',
      provider: 'stepfun',
      diagnosticsPath,
      models: { 'reasoning-fast': 'step-test-model' },
    }, new FailingRunner());

    await assert.rejects(() => attempts.run({
      task: taskRequest(),
      attemptNumber: 2,
      mode: 'runtime_retry',
    }), (error: unknown) => error instanceof CommandExecutionError
      && error.code === 'AGENT_RUNTIME_TIMEOUT');

    const timing = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as {
      mode: string;
      attemptNumber: number;
      errorCode?: string;
      stdoutBytes: number;
      stderrBytes: number;
    };
    assert.equal(timing.mode, 'runtime_retry');
    assert.equal(timing.attemptNumber, 2);
    assert.equal(timing.errorCode, 'AGENT_RUNTIME_TIMEOUT');
    assert.equal(timing.stdoutBytes, 0);
    assert.equal(timing.stderrBytes, 'provider stderr'.length);
    assert.equal(JSON.stringify(timing).includes('provider stderr'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    execCallCount: 0,
    scriptCallCount: 0,
  };
}

test('TaskExecutor owns runtime retry inside one total three-attempt budget', async () => {
  const attempts = new SequenceAttemptRunner([
    new CommandExecutionError('timeout', 'AGENT_RUNTIME_TIMEOUT'),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);
  const result = await executor.execute(taskRequest());

  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(result.runtime.attemptCount, 2);
  assert.equal(attempts.requests.length, 2);
  assert.equal(attempts.requests[0]?.mode, 'normal');
  assert.equal(attempts.requests[1]?.mode, 'runtime_retry');
});

test('TaskExecutor uses Format Repair only after final-result formatting failure', async () => {
  const attempts = new SequenceAttemptRunner([
    new AgentResultFormatError('AGENT_RESULT_INVALID', 'bad json', '{"status":'),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);
  const result = await executor.execute(taskRequest());

  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(attempts.requests.length, 2);
  assert.equal(attempts.requests[1]?.mode, 'format_repair');
  assert.equal(attempts.requests[1]?.repairCandidate, '{"status":');
});

test('Format Repair prompt carries the malformed candidate into the next Agent attempt', async () => {
  const runner = new SequenceCaptureRunner();
  const attempts = new NemoClawOpenClawAttemptRunner({
    sandboxName: 'my-assistant',
    provider: 'stepfun',
    models: { 'reasoning-fast': 'step-test-model' },
  }, runner);
  const executor = new NemoClawAgentTaskExecutor(attempts);

  await executor.execute(taskRequest());

  assert.equal(runner.inputs.length, 2);
  assert.match(runner.inputs[1] ?? '', /LIFE_INTERVIEW_FORMAT_REPAIR_CANDIDATE/);
  assert.match(runner.inputs[1] ?? '', /malformed candidate/);
});

test('TaskExecutor sends schema or business validation failure to Validation Repair', async () => {
  const attempts = new SequenceAttemptRunner([
    okAttempt({ status: 'broken', gaps: [] }),
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);
  const result = await executor.execute(taskRequest());

  assert.deepEqual(result.output, { status: 'interviewing', gaps: [] });
  assert.equal(attempts.requests.length, 2);
  assert.equal(attempts.requests[1]?.mode, 'validation_repair');
  assert.deepEqual(attempts.requests[1]?.repairFeedback, [{
    code: 'INVALID_COMPLETION_OUTPUT',
    path: 'status',
    instruction: 'invalid completion output',
  }]);
});

test('TaskExecutor does not retry a cancelled task', async () => {
  const controller = new AbortController();
  controller.abort();
  const attempts = new SequenceAttemptRunner([
    okAttempt({ status: 'interviewing', gaps: [] }),
  ]);
  const executor = new NemoClawAgentTaskExecutor(attempts);

  await assert.rejects(
    () => executor.execute(taskRequest(controller.signal)),
    (error: unknown) => error instanceof CommandExecutionError
      && error.code === 'AGENT_RUNTIME_CANCELLED',
  );
  assert.equal(attempts.requests.length, 0);
});
