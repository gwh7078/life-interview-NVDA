import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storyCloseoutJsonSchema } from '../src/interview/closeout-schema.js';
import {
  callCloseoutModel,
  CloseoutModelError,
  DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS,
  MAX_CLOSEOUT_MAX_OUTPUT_TOKENS,
} from '../src/interview/llm-provider.js';

const prompt = { system: 'system-only sentinel', user: 'transcript sentinel' };
const config = { apiKey: 'test-secret' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function functionResponse(argumentsText: string, options: {
  status?: number;
  finishReason?: string;
  model?: string;
  id?: string;
  toolName?: string;
} = {}): Response {
  return jsonResponse({
    ...(options.id ? { id: options.id } : {}),
    ...(options.model ? { model: options.model } : {}),
    choices: [{
      finish_reason: options.finishReason ?? 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: options.toolName ?? 'submit_story_closeout', arguments: argumentsText },
        }],
      },
    }],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  }, options.status ?? 200);
}

function responsesApiResponse(outputText: string, options: {
  status?: string;
  incompleteReason?: string;
  model?: string;
  id?: string;
} = {}): Response {
  return jsonResponse({
    ...(options.id ? { id: options.id } : {}),
    ...(options.model ? { model: options.model } : {}),
    status: options.status ?? 'completed',
    ...(options.incompleteReason ? { incomplete_details: { reason: options.incompleteReason } } : {}),
    output: [{
      type: 'message',
      role: 'assistant',
      status: options.status === 'incomplete' ? 'incomplete' : 'completed',
      content: [{ type: 'output_text', text: outputText }],
    }],
    usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 },
  });
}

function chatJsonSchemaResponse(outputText: string): Response {
  return jsonResponse({
    id: 'chatcmpl-qwen-test',
    model: 'qwen3.8-flash',
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: outputText },
    }],
    usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
  });
}

async function withFetchMock<T>(mock: typeof fetch, action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test('uses strict Agent Plan function calling and returns parsed output plus safe diagnostics', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const outputText = '{"summary":"整理完成"}';
  await withFetchMock(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return functionResponse(outputText, { id: 'response-1', model: 'deepseek-v4-flash-2026-01' });
  }, async () => {
    const result = await callCloseoutModel(prompt, config);
    assert.deepEqual(result.output, { summary: '整理完成' });
    assert.equal(result.model, 'deepseek-v4-flash-2026-01');
    assert.equal(result.responseId, 'response-1');
    assert.deepEqual(result.usage, { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
    assert.deepEqual(result.diagnostics, {
      responseId: 'response-1',
      responseModel: 'deepseek-v4-flash-2026-01',
      responseStatus: 200,
      choiceCount: 1,
      finishReason: 'tool_calls',
      contentType: 'null',
      responseChannel: 'tool_calls',
      toolCallCount: 1,
      argumentsType: 'string',
      argumentsLength: outputText.length,
      requestedMaxTokens: DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS,
    });
    assert.ok(result.latencyMs >= 0);
  });

  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions');
  assert.equal(capturedInit?.method, 'POST');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-secret');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.messages, [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_story_closeout' } });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS);
  assert.equal(body.response_format, undefined);
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  const functionDefinition = tools[0].function as Record<string, unknown>;
  assert.equal(functionDefinition.name, 'submit_story_closeout');
  assert.equal(functionDefinition.strict, true);
  assert.deepEqual(functionDefinition.parameters, storyCloseoutJsonSchema);
});

test('uses the requested structured-output name for independent text tasks', async () => {
  let capturedInit: RequestInit | undefined;
  await withFetchMock(async (_input, init) => {
    capturedInit = init;
    return functionResponse('{"status":"complete","gaps":[]}', { toolName: 'story_completion' });
  }, async () => {
    const result = await callCloseoutModel(prompt, {
      ...config,
      structuredOutput: { name: 'story_completion', schema: { type: 'object' } },
    });
    assert.deepEqual(result.output, { status: 'complete', gaps: [] });
  });

  const body = JSON.parse(String(capturedInit?.body)) as Record<string, any>;
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'story_completion' } });
  assert.equal(body.tools[0].function.name, 'story_completion');
});

test('supports injected root URL, model, timeout, and output budget', async () => {
  assert.equal(DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS, 8_192);
  assert.equal(MAX_CLOSEOUT_MAX_OUTPUT_TOKENS, 16_384);
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  await withFetchMock(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return functionResponse('{"ok":true}');
  }, async () => {
    const result = await callCloseoutModel(prompt, {
      ...config,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible/v1/',
      model: 'custom-model',
      timeoutMs: 2_000,
      maxOutputTokens: 6_144,
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal(result.model, 'custom-model');
  });
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/compatible/v1/chat/completions');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  assert.equal((JSON.parse(String(capturedInit?.body)) as Record<string, unknown>).max_tokens, 6_144);
});

test('uses Responses API with strict JSON Schema and parses output_text', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const outputText = '{"current_story":{"summary":"整理完成","source_message_ids":[]},"new_stories":[]}';
  await withFetchMock(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return responsesApiResponse(outputText, { id: 'resp-1', model: 'doubao-seed-2-1-pro-260628' });
  }, async () => {
    const result = await callCloseoutModel(prompt, {
      ...config,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiFormat: 'responses',
      model: 'doubao-seed-2-1-pro-260628',
    });
    assert.deepEqual(result.output, { current_story: { summary: '整理完成', source_message_ids: [] }, new_stories: [] });
    assert.equal(result.model, 'doubao-seed-2-1-pro-260628');
    assert.equal(result.responseId, 'resp-1');
    assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 17, total_tokens: 59 });
    assert.equal(result.diagnostics?.responseChannel, 'content');
    assert.equal(result.diagnostics?.finishReason, 'stop');
    assert.equal(result.diagnostics?.contentLength, outputText.length);
  });

  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/responses');
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'doubao-seed-2-1-pro-260628');
  assert.equal(body.instructions, prompt.system);
  assert.deepEqual(body.input, [{
    role: 'user',
    content: [{ type: 'input_text', text: prompt.user }],
  }]);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_output_tokens, DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS);
  assert.equal(body.store, false);
  const text = body.text as Record<string, unknown>;
  const format = text.format as Record<string, unknown>;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.name, 'story_closeout');
  assert.equal(format.strict, true);
  assert.deepEqual(format.schema, storyCloseoutJsonSchema);
});

test('treats Responses API output cut off by max_output_tokens as retryable truncation', async () => {
  await withFetchMock(async () => responsesApiResponse('{"partial":', {
    status: 'incomplete',
    incompleteReason: 'max_output_tokens',
  }), async () => {
    await assert.rejects(callCloseoutModel(prompt, { ...config, apiFormat: 'responses' }), (error: unknown) => {
      assert.ok(error instanceof CloseoutModelError);
      assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
      assert.equal(error.retryable, true);
      assert.equal(error.diagnostics?.finishReason, 'length');
      return true;
    });
  });
});

test('uses DashScope Chat Completions strict JSON Schema without max_tokens', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const outputText = '{"current_story":{"summary":"整理完成","source_message_ids":[]},"new_stories":[]}';
  await withFetchMock(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return chatJsonSchemaResponse(outputText);
  }, async () => {
    const result = await callCloseoutModel(prompt, {
      ...config,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiFormat: 'chat-json-schema',
      model: 'qwen3.8-flash',
    });
    assert.deepEqual(result.output, { current_story: { summary: '整理完成', source_message_ids: [] }, new_stories: [] });
    assert.equal(result.model, 'qwen3.8-flash');
    assert.equal(result.responseId, 'chatcmpl-qwen-test');
    assert.deepEqual(result.usage, { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
    assert.equal(result.diagnostics?.responseChannel, 'content');
    assert.equal(result.diagnostics?.finishReason, 'stop');
    assert.equal(result.diagnostics?.requestedMaxTokens, undefined);
  });

  assert.equal(capturedUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer test-secret');
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'qwen3.8-flash');
  assert.deepEqual(body.messages, [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]);
  assert.deepEqual(body.enable_thinking, false);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.tools, undefined);
  const responseFormat = body.response_format as Record<string, unknown>;
  const schemaDefinition = responseFormat.json_schema as Record<string, unknown>;
  assert.equal(responseFormat.type, 'json_schema');
  assert.equal(schemaDefinition.name, 'story_closeout');
  assert.equal(schemaDefinition.strict, true);
  assert.deepEqual(schemaDefinition.schema, storyCloseoutJsonSchema);
});

test('sanitizes malformed function arguments and never includes key, prompt, or raw output', async () => {
  const privateOutput = 'transcript sentinel not-json private provider detail';
  await withFetchMock(async () => functionResponse(privateOutput), async () => {
    await assert.rejects(callCloseoutModel(prompt, config), (error: unknown) => {
      assert.ok(error instanceof CloseoutModelError);
      assert.equal(error.code, 'MODEL_OUTPUT_INVALID');
      assert.equal(error.retryable, true);
      assert.match(error.message, /malformed function arguments/);
      assert.equal(error.diagnostics?.responseChannel, 'tool_calls');
      assert.equal(error.diagnostics?.argumentsType, 'string');
      assert.equal(error.diagnostics?.argumentsLength, privateOutput.length);
      assert.equal(error.diagnostics?.parseErrorName, 'SyntaxError');
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /transcript sentinel|not-json|private provider detail/);
      return true;
    });
  });
});

test('rejects plain text replies when a structured function call is required', async () => {
  await withFetchMock(async () => jsonResponse({
    choices: [{ finish_reason: 'stop', message: { content: 'transcript sentinel private text' } }],
  }), async () => {
    await assert.rejects(callCloseoutModel(prompt, config), (error: unknown) => {
      assert.ok(error instanceof CloseoutModelError);
      assert.equal(error.code, 'MODEL_OUTPUT_INVALID');
      assert.equal(error.diagnostics?.responseChannel, 'content');
      assert.equal(error.diagnostics?.toolCallCount, 0);
      assert.equal(JSON.stringify(error.diagnostics).includes('private text'), false);
      return true;
    });
  });
});

test('sanitizes HTTP errors and never includes provider body, API key, or prompt', async () => {
  const secretBody = 'test-secret transcript sentinel private provider detail';
  await withFetchMock(async () => jsonResponse({ error: secretBody }, 429), async () => {
    await assert.rejects(
      callCloseoutModel(prompt, config),
      (error: unknown) => {
        assert.ok(error instanceof CloseoutModelError);
        assert.match(error.message, /HTTP 429/);
        assert.deepEqual(error.diagnostics, { responseStatus: 429 });
        assert.doesNotMatch(error.message, /test-secret|transcript sentinel|private provider detail/);
        return true;
      },
    );
  });
});

test('marks transient provider status codes retryable but leaves authentication errors terminal', async () => {
  for (const [status, expectedRetryable] of [[429, true], [503, true], [401, false]] as const) {
    await withFetchMock(async () => jsonResponse({ error: 'private provider detail' }, status), async () => {
      await assert.rejects(callCloseoutModel(prompt, config), (error: unknown) => {
        assert.ok(error instanceof CloseoutModelError);
        assert.equal(error.code, 'MODEL_HTTP_ERROR');
        assert.equal(error.retryable, expectedRetryable);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /private provider detail/);
        return true;
      });
    });
  }
});

test('accepts generic HTTPS OpenAI-compatible endpoints and keeps bearer auth', async () => {
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  await withFetchMock(async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    return functionResponse('{"ok":true}');
  }, async () => {
    const result = await callCloseoutModel(prompt, {
      ...config,
      baseUrl: 'https://models.example.test/v1/',
      model: 'portable-model',
    });
    assert.deepEqual(result.output, { ok: true });
  });
  assert.equal(capturedUrl, 'https://models.example.test/v1/chat/completions');
  assert.equal(capturedHeaders.get('authorization'), 'Bearer test-secret');
});

test('allows loopback HTTP local runtimes without an API key', async () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    await withFetchMock(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return functionResponse('{"ok":true}', { model: 'local-runtime-model' });
    }, async () => {
      const result = await callCloseoutModel(prompt, {
        apiKey: '',
        baseUrl: `http://${host}:8001/v1`,
        model: 'local-runtime-model',
      });
      assert.deepEqual(result.output, { ok: true });
      assert.equal(result.model, 'local-runtime-model');
    });
    assert.equal(capturedUrl, `http://${host}:8001/v1/chat/completions`);
    assert.equal(capturedHeaders.get('authorization'), null);
    assert.equal(capturedHeaders.get('content-type'), 'application/json');
  }
});

test('rejects insecure remote or credential-bearing model endpoints before fetching', async () => {
  let fetchCalls = 0;
  await withFetchMock(async () => {
    fetchCalls += 1;
    return functionResponse('{"ok":true}');
  }, async () => {
    for (const baseUrl of [
      'http://models.example.test/v1',
      'https://user:password@models.example.test/v1',
      'https://models.example.test/v1?token=secret',
    ]) {
      await assert.rejects(
        callCloseoutModel(prompt, { ...config, baseUrl }),
        (error: unknown) => error instanceof CloseoutModelError && error.code === 'MODEL_ENDPOINT_INVALID',
      );
    }
  });
  assert.equal(fetchCalls, 0);
});

test('treats a truncated function response as a repairable model output error', async () => {
  await withFetchMock(async () => functionResponse('{"partial":', { finishReason: 'length' }), async () => {
    await assert.rejects(callCloseoutModel(prompt, config), (error: unknown) => {
      assert.ok(error instanceof CloseoutModelError);
      assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
      assert.equal(error.retryable, true);
      assert.equal(error.diagnostics?.finishReason, 'length');
      return true;
    });
  });
});

test('enforces request timeout and returns a sanitized timeout error', async () => {
  await withFetchMock((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }), async () => {
    await assert.rejects(callCloseoutModel(prompt, { ...config, timeoutMs: 10 }), /request timed out/);
  });
});

test('does not expose low-level network error details', async () => {
  await withFetchMock(async () => {
    throw new Error('failed https://example.test/?token=test-secret transcript sentinel');
  }, async () => {
    await assert.rejects(callCloseoutModel(prompt, config), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed before receiving a response/);
      assert.doesNotMatch(error.message, /test-secret|transcript sentinel|example\.test/);
      return true;
    });
  });
});

test('requires credentials for remote endpoints and validates timeout/output budgets before fetching', async () => {
  await assert.rejects(callCloseoutModel(prompt, { apiKey: ' ' }), /API key is required/);
  await assert.rejects(callCloseoutModel(prompt, { ...config, timeoutMs: 0 }), /timeout must be between/);
  await assert.rejects(callCloseoutModel(prompt, { ...config, maxOutputTokens: 65_537 }), /max output tokens must be between/);
});
