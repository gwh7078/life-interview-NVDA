import { DEFAULT_CLOUD_TEXT_BASE_URL } from '../models/text-runtime.js';
import { storyCloseoutJsonSchema } from './closeout-schema.js';

const DEFAULT_BASE_URL = DEFAULT_CLOUD_TEXT_BASE_URL;
const DEFAULT_MODEL = 'qwen3.6-35b-a3b';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS = 8_192;
export const MAX_CLOSEOUT_MAX_OUTPUT_TOKENS = 16_384;
const CLOSEOUT_TOOL_NAME = 'submit_story_closeout';

export interface CloseoutModelConfig {
  apiKey: string;
  /** Root API URL without the endpoint path. */
  baseUrl?: string;
  apiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  structuredOutput?: { name: string; schema: Record<string, unknown> };
}

export interface CloseoutModelResult {
  output: unknown;
  model: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  diagnostics?: CloseoutModelDiagnostics;
  latencyMs: number;
}

/** Safe response metadata only; never contains content, prompts, or reasoning text. */
export interface CloseoutModelDiagnostics {
  responseId?: string;
  responseModel?: string;
  responseStatus?: number;
  choiceCount?: number;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'insufficient_system_resource' | 'aborted' | 'unknown';
  contentType?: 'string' | 'null' | 'object' | 'array' | 'number' | 'boolean' | 'undefined';
  contentLength?: number;
  responseChannel?: 'tool_calls' | 'content' | 'none';
  toolCallCount?: number;
  argumentsType?: 'string' | 'null' | 'object' | 'array' | 'number' | 'boolean' | 'undefined';
  argumentsLength?: number;
  requestedMaxTokens?: number;
  parseErrorName?: string;
  parseErrorPosition?: number;
  responseJsonInvalid?: boolean;
}

export class CloseoutModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly diagnostics?: CloseoutModelDiagnostics,
  ) {
    super(message);
    this.name = 'CloseoutModelError';
  }
}

interface ModelEndpoint {
  url: string;
  requiresApiKey: boolean;
}

function endpointFor(baseUrl: string | undefined, apiFormat: CloseoutModelConfig['apiFormat']): ModelEndpoint {
  const root = baseUrl?.trim() || DEFAULT_BASE_URL;
  try {
    const url = new URL(root);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    const secureRemote = url.protocol === 'https:' && !loopback;
    const localRuntime = loopback && (url.protocol === 'http:' || url.protocol === 'https:');
    if ((!secureRemote && !localRuntime) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid');
    }
    const endpoint = apiFormat === 'responses' ? 'responses' : 'chat/completions';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
    return { url: url.toString(), requiresApiKey: !loopback };
  } catch {
    throw new CloseoutModelError(
      'Text model base URL must use HTTPS, except loopback local runtimes may use HTTP.',
      'MODEL_ENDPOINT_INVALID',
      false,
    );
  }
}

function parseResponseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CloseoutModelError('Closeout model returned an invalid response.', 'MODEL_RESPONSE_INVALID', true);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._:/_-]{1,160}$/.test(value)
    ? value
    : undefined;
}

function contentType(value: unknown): CloseoutModelDiagnostics['contentType'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'undefined';
}

function responseDiagnostics(
  response: Record<string, unknown>,
  responseStatus: number,
  choiceCount: number,
  finishReason: unknown,
  content: unknown,
  toolCalls: unknown,
  toolArguments: unknown,
  requestedMaxTokens: number | undefined,
): CloseoutModelDiagnostics {
  const allowedFinishReasons = new Set([
    'stop', 'length', 'content_filter', 'tool_calls',
    'insufficient_system_resource', 'aborted',
  ]);
  return {
    ...(safeIdentifier(response.id) ? { responseId: safeIdentifier(response.id) } : {}),
    ...(safeIdentifier(response.model) ? { responseModel: safeIdentifier(response.model) } : {}),
    responseStatus,
    choiceCount,
    finishReason: typeof finishReason === 'string' && allowedFinishReasons.has(finishReason)
      ? finishReason as CloseoutModelDiagnostics['finishReason']
      : 'unknown',
    contentType: contentType(content),
    ...(typeof content === 'string' ? { contentLength: content.length } : {}),
    responseChannel: Array.isArray(toolCalls) && toolCalls.length > 0
      ? 'tool_calls'
      : content === null || content === undefined ? 'none' : 'content',
    toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
    argumentsType: contentType(toolArguments),
    ...(typeof toolArguments === 'string' ? { argumentsLength: toolArguments.length } : {}),
    ...(requestedMaxTokens !== undefined ? { requestedMaxTokens } : {}),
  };
}

/** Calls the configured Ark endpoint and returns parsed output plus safe metadata. */
export async function callCloseoutModel(
  prompt: { system: string; user: string },
  config: CloseoutModelConfig,
): Promise<CloseoutModelResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new CloseoutModelError(
      `Closeout model timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`,
      'MODEL_TIMEOUT_INVALID',
      false,
    );
  }

  const model = config.model?.trim() || DEFAULT_MODEL;
  const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_CLOSEOUT_MAX_OUTPUT_TOKENS) {
    throw new CloseoutModelError(
      `Closeout model max output tokens must be between 1 and ${MAX_CLOSEOUT_MAX_OUTPUT_TOKENS}.`,
      'MODEL_OUTPUT_LIMIT_INVALID',
      false,
    );
  }
  const apiFormat = config.apiFormat ?? 'chat-completions';
  if (apiFormat !== 'chat-completions' && apiFormat !== 'chat-json-schema' && apiFormat !== 'responses') {
    throw new CloseoutModelError('Closeout model API format is invalid.', 'MODEL_API_FORMAT_INVALID', false);
  }
  const temperature = config.temperature ?? 0.3;
  if (apiFormat !== 'chat-completions' && (!Number.isFinite(temperature) || temperature < 0 || temperature >= 2)) {
    throw new CloseoutModelError('Closeout model temperature must be between 0 and 2.', 'MODEL_TEMPERATURE_INVALID', false);
  }
  const endpoint = endpointFor(config.baseUrl, apiFormat);
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (endpoint.requiresApiKey && !apiKey) {
    throw new CloseoutModelError('Text model API key is required for remote endpoints.', 'MODEL_KEY_REQUIRED', false);
  }
  const structuredOutput = config.structuredOutput ?? { name: 'story_closeout', schema: storyCloseoutJsonSchema as Record<string, unknown> };
  const toolName = config.structuredOutput?.name ?? CLOSEOUT_TOOL_NAME;
  const startedAt = performance.now();
  const requestController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);
  const cancelRequest = () => requestController.abort();
  if (config.signal?.aborted) {
    clearTimeout(timeout);
    throw new CloseoutModelError('Closeout model request was cancelled.', 'MODEL_CANCELLED', false);
  }
  config.signal?.addEventListener('abort', cancelRequest, { once: true });

  let response: Response;
  try {
    try {
      response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify(apiFormat === 'responses'
          ? {
              model,
              instructions: prompt.system,
              input: [{
                role: 'user',
                content: [{ type: 'input_text', text: prompt.user }],
              }],
              text: {
                format: {
                  type: 'json_schema',
                  name: structuredOutput.name,
                  schema: structuredOutput.schema,
                  strict: true,
                },
              },
              thinking: { type: 'disabled' },
              temperature,
              max_output_tokens: maxOutputTokens,
              store: false,
            }
          : apiFormat === 'chat-json-schema'
            ? {
                model,
                messages: [
                  { role: 'system', content: prompt.system },
                  { role: 'user', content: prompt.user },
                ],
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: structuredOutput.name,
                    strict: true,
                    schema: structuredOutput.schema,
                  },
                },
                enable_thinking: false,
                temperature,
              }
            : {
              model,
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              tools: [{
                type: 'function',
                function: {
                  name: toolName,
                  description: 'Return the validated structured result for this text task.',
                  strict: true,
                  parameters: structuredOutput.schema,
                },
              }],
              tool_choice: { type: 'function', function: { name: toolName } },
              thinking: { type: 'disabled' },
              max_tokens: maxOutputTokens,
            }),
        signal: requestController.signal,
      });
    } catch (error) {
      if (config.signal?.aborted) {
        throw new CloseoutModelError('Closeout model request was cancelled.', 'MODEL_CANCELLED', false);
      }
      if (timedOut || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new CloseoutModelError('Closeout model request timed out.', 'MODEL_TIMEOUT', true);
      }
      throw new CloseoutModelError('Closeout model request failed before receiving a response.', 'MODEL_NETWORK_ERROR', true);
    }
    if (!response.ok) {
      const retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
      throw new CloseoutModelError(
        `Closeout model request failed (HTTP ${response.status}).`,
        'MODEL_HTTP_ERROR',
        retryable,
        { responseStatus: response.status },
      );
    }

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      if (config.signal?.aborted) {
        throw new CloseoutModelError('Closeout model request was cancelled.', 'MODEL_CANCELLED', false);
      }
      if (timedOut) throw new CloseoutModelError('Closeout model request timed out.', 'MODEL_TIMEOUT', true);
      throw new CloseoutModelError(
        'Closeout model returned an invalid response.',
        'MODEL_RESPONSE_INVALID',
        true,
        { responseStatus: response.status, responseJsonInvalid: true },
      );
    }

    let result: Record<string, unknown>;
    try {
      result = parseResponseObject(rawResponse);
    } catch {
      throw new CloseoutModelError(
        'Closeout model returned an invalid response.',
        'MODEL_RESPONSE_INVALID',
        true,
        { responseStatus: response.status, responseJsonInvalid: true },
      );
    }
    if (apiFormat === 'responses') {
      const outputItems = Array.isArray(result.output) ? result.output : [];
      const messageItems = outputItems.filter((item) => isRecord(item) && item.type === 'message');
      const outputText = messageItems.flatMap((item) => {
        if (!isRecord(item) || !Array.isArray(item.content)) return [];
        return item.content.flatMap((part) =>
          isRecord(part) && part.type === 'output_text' && typeof part.text === 'string'
            ? [part.text]
            : []);
      }).join('');
      const incompleteDetails = isRecord(result.incomplete_details) ? result.incomplete_details : undefined;
      const incompleteReason = incompleteDetails?.reason;
      const responseState = result.status;
      const finishReason = responseState === 'completed'
        ? 'stop'
        : responseState === 'incomplete' && incompleteReason === 'max_output_tokens'
          ? 'length'
          : 'unknown';
      const diagnostics = responseDiagnostics(
        result,
        response.status,
        messageItems.length,
        finishReason,
        outputText || undefined,
        undefined,
        undefined,
        maxOutputTokens,
      );
      if (responseState === 'incomplete') {
        throw new CloseoutModelError(
          incompleteReason === 'max_output_tokens'
            ? 'Closeout model output exceeded its response limit.'
            : 'Closeout model returned an incomplete response.',
          incompleteReason === 'max_output_tokens' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_OUTPUT_INCOMPLETE',
          true,
          diagnostics,
        );
      }
      if (responseState !== 'completed') {
        throw new CloseoutModelError(
          'Closeout model did not complete the response.',
          'MODEL_OUTPUT_INVALID',
          true,
          diagnostics,
        );
      }
      if (!outputText) {
        throw new CloseoutModelError(
          'Closeout model returned no structured JSON output.',
          'MODEL_OUTPUT_INVALID',
          true,
          diagnostics,
        );
      }

      let output: unknown;
      try {
        output = JSON.parse(outputText) as unknown;
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : '';
        const position = /position\s+(\d+)/i.exec(parseMessage)?.[1];
        throw new CloseoutModelError(
          'Closeout model returned malformed JSON output.',
          'MODEL_OUTPUT_INVALID',
          true,
          {
            ...diagnostics,
            parseErrorName: error instanceof Error ? error.name : 'ParseError',
            ...(position ? { parseErrorPosition: Number(position) } : {}),
          },
        );
      }

      return {
        output,
        model: safeIdentifier(result.model) ?? safeIdentifier(model) ?? DEFAULT_MODEL,
        ...(safeIdentifier(result.id) ? { responseId: safeIdentifier(result.id) } : {}),
        ...(isRecord(result.usage) ? { usage: { ...result.usage } } : {}),
        diagnostics,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }

    const choices = result.choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
    const choice = isRecord(firstChoice) ? firstChoice : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;
    const content = message?.content;
    const rawToolCalls = message?.tool_calls;
    const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : undefined;
    const firstToolCall = toolCalls && isRecord(toolCalls[0]) ? toolCalls[0] : undefined;
    const functionCall = firstToolCall && isRecord(firstToolCall.function) ? firstToolCall.function : undefined;
    const argumentsValue = functionCall?.arguments;
    const diagnostics = responseDiagnostics(
      result,
      response.status,
      Array.isArray(choices) ? choices.length : 0,
      choice?.finish_reason,
      content,
      rawToolCalls,
      argumentsValue,
      apiFormat === 'chat-json-schema' ? undefined : maxOutputTokens,
    );
    if (choice?.finish_reason === 'length') {
      throw new CloseoutModelError(
        'Closeout model output exceeded its response limit.',
        'MODEL_OUTPUT_TRUNCATED',
        true,
        diagnostics,
      );
    }
    if (apiFormat === 'chat-json-schema') {
      if (typeof content !== 'string') {
        throw new CloseoutModelError(
          'Closeout model returned no structured JSON output.',
          'MODEL_OUTPUT_INVALID',
          true,
          diagnostics,
        );
      }
      let output: unknown;
      try {
        output = JSON.parse(content) as unknown;
      } catch (error) {
        const parseMessage = error instanceof Error ? error.message : '';
        const position = /position\s+(\d+)/i.exec(parseMessage)?.[1];
        throw new CloseoutModelError(
          'Closeout model returned malformed JSON output.',
          'MODEL_OUTPUT_INVALID',
          true,
          {
            ...diagnostics,
            parseErrorName: error instanceof Error ? error.name : 'ParseError',
            ...(position ? { parseErrorPosition: Number(position) } : {}),
          },
        );
      }
      return {
        output,
        model: safeIdentifier(result.model) ?? safeIdentifier(model) ?? DEFAULT_MODEL,
        ...(safeIdentifier(result.id) ? { responseId: safeIdentifier(result.id) } : {}),
        ...(isRecord(result.usage) ? { usage: { ...result.usage } } : {}),
        diagnostics,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }

    if (!toolCalls || toolCalls.length !== 1 || functionCall?.name !== toolName
      || typeof argumentsValue !== 'string') {
      throw new CloseoutModelError(
        'Closeout model returned no structured function result.',
        'MODEL_OUTPUT_INVALID',
        true,
        diagnostics,
      );
    }

    let output: unknown;
    try {
      output = JSON.parse(argumentsValue) as unknown;
    } catch (error) {
      const parseMessage = error instanceof Error ? error.message : '';
      const position = /position\s+(\d+)/i.exec(parseMessage)?.[1];
      throw new CloseoutModelError(
        'Closeout model returned malformed function arguments.',
        'MODEL_OUTPUT_INVALID',
        true,
        {
          ...diagnostics,
          parseErrorName: error instanceof Error ? error.name : 'ParseError',
          ...(position ? { parseErrorPosition: Number(position) } : {}),
        },
      );
    }

    return {
      output,
      model: safeIdentifier(result.model) ?? safeIdentifier(model) ?? DEFAULT_MODEL,
      ...(safeIdentifier(result.id) ? { responseId: safeIdentifier(result.id) } : {}),
      ...(isRecord(result.usage) ? { usage: { ...result.usage } } : {}),
      diagnostics,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } finally {
    clearTimeout(timeout);
    config.signal?.removeEventListener('abort', cancelRequest);
  }
}
