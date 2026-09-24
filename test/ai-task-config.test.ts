import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAiTaskConfig } from '../src/ai/task-config.js';
import { readRuntimeConfig } from '../src/server.js';

function withEnvironment(values: Record<string, string | undefined>, callback: () => void): void {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    original.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { callback(); }
  finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('realtime and text tasks use independent credentials and model routes', () => {
  const env = {
    STORY_INTERVIEW_PROVIDER: 'qwen',
    STORY_INTERVIEW_MODEL: 'qwen-interview-test',
    DASHSCOPE_WORKSPACE_ID: 'test-workspace',
    DASHSCOPE_API_KEY: 'qwen-secret-not-config',
    TEXT_MODEL_PROVIDER: 'openai-compatible',
    TEXT_MODEL_BASE_URL: 'https://text.example/v1',
    TEXT_MODEL: 'text-model-test',
    CLOSEOUT_API_KEY: 'text-secret-not-config',
    NODE_ENV: 'test',
    AUTH_MODE: 'demo_phone',
  };
  const taskConfig = resolveAiTaskConfig(env as NodeJS.ProcessEnv);
  assert.equal(taskConfig['interview.story'].model, 'qwen-interview-test');
  assert.equal(taskConfig['closeout.story'].model, 'text-model-test');
  assert.equal(JSON.stringify(taskConfig).includes('secret-not-config'), false);

  withEnvironment(env, () => {
    const runtime = readRuntimeConfig();
    assert.equal(runtime.defaultRealtimeProvider, 'qwen');
    assert.equal(runtime.model, 'qwen-interview-test');
    assert.equal(runtime.closeoutModel, 'text-model-test');
    assert.equal(runtime.apiKey, 'qwen-secret-not-config');
    assert.equal(runtime.closeoutApiKey, 'text-secret-not-config');
  });
});

test('one shared text runtime profile routes all text tasks without changing business task names', () => {
  const taskConfig = resolveAiTaskConfig({
    TEXT_MODEL_PROVIDER: 'openai-compatible',
    TEXT_MODEL_BASE_URL: 'http://127.0.0.1:8001/v1',
    TEXT_MODEL: 'local-text-model',
    TEXT_MODEL_API_FORMAT: 'chat-completions',
    TEXT_MODEL_TIMEOUT_MS: '45678',
  } as NodeJS.ProcessEnv);

  for (const taskName of ['closeout.story', 'closeout.onboarding', 'completion.story', 'generation.story'] as const) {
    assert.equal(taskConfig[taskName].provider, 'openai-compatible');
    assert.equal(taskConfig[taskName].model, 'local-text-model');
    assert.equal(taskConfig[taskName].parameters.baseUrl, 'http://127.0.0.1:8001/v1');
    assert.equal(taskConfig[taskName].parameters.apiFormat, 'chat-completions');
    assert.equal(taskConfig[taskName].parameters.timeoutMs, 45_678);
  }
  assert.equal(taskConfig['interview.story'].provider, 'stepfun',
    'text runtime routing must not implicitly change realtime voice');
});

test('runtime config accepts a loopback local text runtime without requiring a model API key', () => {
  withEnvironment({
    NODE_ENV: 'test',
    AUTH_MODE: 'demo_phone',
    TEXT_MODEL_PROVIDER: 'openai-compatible',
    TEXT_MODEL_BASE_URL: 'http://127.0.0.1:8001/v1',
    TEXT_MODEL: 'local-text-model',
    TEXT_MODEL_API_KEY: undefined,
    CLOSEOUT_API_KEY: undefined,
  }, () => {
    const runtime = readRuntimeConfig();
    assert.equal(runtime.closeoutProvider, 'openai-compatible');
    assert.equal(runtime.closeoutBaseUrl, 'http://127.0.0.1:8001/v1');
    assert.equal(runtime.closeoutModel, 'local-text-model');
    assert.equal(runtime.storyCompletionProvider, 'openai-compatible');
    assert.equal(runtime.storyGenerationProvider, 'openai-compatible');
    assert.equal(runtime.closeoutApiKey, undefined);
    assert.equal(runtime.defaultRealtimeProvider, 'stepfun',
      'text runtime changes must not switch the realtime voice provider');
  });
});

test('Bailian key feeds the generic remote text runtime without changing realtime credentials', () => {
  withEnvironment({
    NODE_ENV: 'test',
    AUTH_MODE: 'demo_phone',
    TEXT_MODEL_PROVIDER: 'openai-compatible',
    TEXT_MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    TEXT_MODEL: 'qwen3.6-35b-a3b',
    TEXT_MODEL_API_KEY: undefined,
    BAILIAN_API_KEY: 'bailian-secret-not-config',
    CLOSEOUT_API_KEY: undefined,
  }, () => {
    const runtime = readRuntimeConfig();
    assert.equal(runtime.closeoutProvider, 'openai-compatible');
    assert.equal(runtime.closeoutBaseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.equal(runtime.closeoutModel, 'qwen3.6-35b-a3b');
    assert.equal(runtime.closeoutApiKey, 'bailian-secret-not-config');
  });
});

test('runtime auth mode defaults to SMS and rejects unknown modes', () => {
  withEnvironment({ AUTH_MODE: 'sms', NODE_ENV: 'test' }, () => {
    assert.equal(readRuntimeConfig().authMode, 'sms');
  });
  withEnvironment({ AUTH_MODE: 'password', NODE_ENV: 'test' }, () => {
    assert.throws(() => readRuntimeConfig(), /AUTH_MODE must be sms or demo_phone/);
  });
});

test('StepFun server VAD silence duration defaults to 1400ms and accepts a runtime override', () => {
  withEnvironment({ NODE_ENV: 'test', AUTH_MODE: 'demo_phone', STEPFUN_REALTIME_SILENCE_DURATION_MS: undefined }, () => {
    assert.equal(readRuntimeConfig().stepfunSilenceDurationMs, 1_400);
  });
  withEnvironment({ NODE_ENV: 'test', AUTH_MODE: 'demo_phone', STEPFUN_REALTIME_SILENCE_DURATION_MS: '2100' }, () => {
    assert.equal(readRuntimeConfig().stepfunSilenceDurationMs, 2_100);
  });
  withEnvironment({ NODE_ENV: 'test', AUTH_MODE: 'demo_phone', STEPFUN_REALTIME_SILENCE_DURATION_MS: '0' }, () => {
    assert.throws(() => readRuntimeConfig(), /STEPFUN_REALTIME_SILENCE_DURATION_MS/);
  });
});

test('Step-Audio 2 Mini is the default realtime provider and legacy Doubao config is rejected', () => {
  const taskConfig = resolveAiTaskConfig({} as NodeJS.ProcessEnv);
  assert.equal(taskConfig['interview.story'].provider, 'stepfun');
  assert.equal(taskConfig['interview.story'].model, 'step-audio-2-mini');
  withEnvironment({
    NODE_ENV: 'test',
    STORY_INTERVIEW_PROVIDER: 'doubao',
  }, () => {
    assert.throws(() => readRuntimeConfig(), /STORY_INTERVIEW_PROVIDER must be qwen or stepfun/);
  });
});

test('task config fails closed for unsupported realtime or text runtime providers', () => {
  assert.throws(() => resolveAiTaskConfig({ STORY_INTERVIEW_PROVIDER: 'openclaw' } as NodeJS.ProcessEnv), /STORY_INTERVIEW_PROVIDER/);
  assert.throws(() => resolveAiTaskConfig({ TEXT_MODEL_PROVIDER: 'openclaw' } as NodeJS.ProcessEnv), /TEXT_MODEL_PROVIDER/);
  assert.throws(() => resolveAiTaskConfig({ CLOSEOUT_PROVIDER: 'openclaw' } as NodeJS.ProcessEnv), /must be volcengine-agent-plan or openai-compatible/);
});
