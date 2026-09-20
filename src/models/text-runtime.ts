export type TextRuntimeProviderId = 'volcengine-agent-plan' | 'openai-compatible';

export const DEFAULT_CLOUD_TEXT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';

export function isTextRuntimeProviderId(value: string): value is TextRuntimeProviderId {
  return value === 'volcengine-agent-plan' || value === 'openai-compatible';
}

export function isLoopbackTextRuntimeUrl(baseUrl: string | undefined): boolean {
  const root = baseUrl?.trim() || DEFAULT_CLOUD_TEXT_BASE_URL;
  try {
    const url = new URL(root);
    const hostname = url.hostname.toLowerCase();
    return (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')
      && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

/**
 * Text runtime identity is transport-oriented rather than model-oriented.
 * Model names and endpoints are configuration, so cloud and loopback local runtimes
 * can share the same application-facing provider contract.
 */
export interface TextRuntimeDescriptor {
  provider: TextRuntimeProviderId;
  baseUrl: string;
  model: string;
}
