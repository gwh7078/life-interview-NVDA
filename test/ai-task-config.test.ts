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

test('AI task configuration keeps realtime and closeout model routing independent and is used by runtime setup', () => {
  const env = {
    STORY_INTERVIEW_PROVIDER: 'qwen',
    STORY_INTERVIEW_MODEL: 'qwen-interview-test',
    STEPFUN_REALTIME_MODEL: undefined,
    DASHSCOPE_REGION: 'ap-southeast-1',
    DASHSCOPE_WORKSPACE_ID: 'test-workspace',
    DASHSCOPE_API_KEY: 'qwen-secret-not-config',
    CLOSEOUT_PROVIDER: 'volcengine-agent-plan',
    CLOSEOUT_MODEL: 'closeout-text-test',
    ONBOARDING_CLOSEOUT_MODEL: 'onboarding-closeout-test',
    CLOSEOUT_API_FORMAT: 'responses',
    CLOSEOUT_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    CLOSEOUT_TIMEOUT_MS: '12345',
    STORY_COMPLETION_PROVIDER: 'volcengine-agent-plan',
    STORY_COMPLETION_MODEL: 'completion-text-test',
    STORY_COMPLETION_API_FORMAT: 'responses',
    STORY_COMPLETION_BASE_URL: 'https://completion.example/v1',
    STORY_COMPLETION_TIMEOUT_MS: '23456',
    STORY_GENERATION_MODEL: 'generation-text-test',
    STORY_GENERATION_API_FORMAT: 'chat-json-schema',
    STORY_GENERATION_BASE_URL: 'https://generation.example/v1',
    STORY_GENERATION_TIMEOUT_MS: '34567',
    CLOSEOUT_API_KEY: 'text-secret-not-config',
    HOST: '127.0.0.1',
    PORT: '4174',
    AUTH_MODE: 'demo_phone',
    NODE_ENV: 'test',
  };
  const taskConfig = resolveAiTaskConfig(env as NodeJS.ProcessEnv);
  assert.equal(taskConfig['interview.story'].provider, 'qwen');
  assert.equal(taskConfig['interview.story'].model, 'qwen-interview-test');
  assert.equal(taskConfig['closeout.story'].provider, 'volcengine-agent-plan');
  assert.equal(taskConfig['closeout.story'].model, 'closeout-text-test');
  assert.equal(taskConfig['closeout.onboarding'].provider, 'volcengine-agent-plan');
  assert.equal(taskConfig['closeout.onboarding'].model, 'onboarding-closeout-test');
  assert.equal(taskConfig['completion.story'].model, 'completion-text-test');
  assert.equal(taskConfig['completion.story'].parameters.apiFormat, 'responses');
  assert.equal(taskConfig['completion.story'].parameters.baseUrl, 'https://completion.example/v1');
  assert.equal(taskConfig['completion.story'].parameters.timeoutMs, 23_456);
  assert.equal(taskConfig['generation.story'].model, 'generation-text-test');
  assert.equal(taskConfig['generation.story'].parameters.apiFormat, 'chat-json-schema');
  assert.equal(taskConfig['generation.story'].parameters.baseUrl, 'https://generation.example/v1');
  assert.equal(taskConfig['generation.story'].parameters.timeoutMs, 34_567);
  assert.equal(JSON.stringify(taskConfig).includes('secret-not-config'), false);

  withEnvironment(env, () => {
    const runtime = readRuntimeConfig();
    assert.equal(runtime.defaultRealtimeProvider, 'qwen');
    assert.equal(runtime.region, 'ap-southeast-1');
    assert.equal(runtime.qwenModel, 'qwen-interview-test');
    assert.equal(runtime.model, 'qwen-interview-test');
    assert.equal(runtime.stepfunModel, 'step-audio-2-mini');
    assert.equal(runtime.closeoutProvider, 'volcengine-agent-plan');
    assert.equal(runtime.closeoutModel, 'closeout-text-test');
    assert.equal(runtime.closeoutApiFormat, 'responses');
    assert.equal(runtime.closeoutTimeoutMs, 12_345);
    assert.equal(runtime.storyCompletionModel, 'completion-text-test');
    assert.equal(runtime.storyCompletionTimeoutMs, 23_456);
    assert.equal(runtime.storyGenerationModel, 'generation-text-test');
    assert.equal(runtime.storyGenerationTimeoutMs, 34_567);
    assert.equal(runtime.apiKey, 'qwen-secret-not-config');
    assert.equal(runtime.closeoutApiKey, 'text-secret-not-config');
    assert.equal(runtime.authMode, 'demo_phone');
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
