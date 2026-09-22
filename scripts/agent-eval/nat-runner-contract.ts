export interface NatError {
  code: string;
  message: string;
  retryable: boolean;
}

export function errorWithCode(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseCaseId(input: string): string {
  const value = input.trim();
  if (!value) throw errorWithCode('NAT_INPUT_INVALID', 'stdin must contain a case_id.');

  let parsed: unknown = value;
  if (value.startsWith('{') || value.startsWith('[') || value.startsWith('"')) {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw errorWithCode('NAT_INPUT_INVALID', 'stdin case_id input is not valid JSON.');
    }
  }

  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const caseId = (parsed as { case_id?: unknown }).case_id;
    if (typeof caseId === 'string' && caseId.trim()) return caseId.trim();
  }
  throw errorWithCode('NAT_INPUT_INVALID', 'stdin must contain a non-empty string case_id.');
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const direct = (error as { code?: unknown }).code;
    if (typeof direct === 'string' && direct.trim()) return direct;
    const feedback = (error as { feedback?: unknown }).feedback;
    if (Array.isArray(feedback)) {
      const code = (feedback[0] as { code?: unknown } | undefined)?.code;
      if (typeof code === 'string' && code.trim()) return code;
    }
  }
  return 'NAT_AGENT_RUN_FAILED';
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer <redacted>')
    .replace(/(API_KEY|TOKEN|PASSWORD|SECRET)=([^\s&]+)/giu, '$1=<redacted>');
}

function isRetryable(code: string): boolean {
  return code === 'AGENT_RUNTIME_UNAVAILABLE'
    || code === 'AGENT_RUNTIME_TIMEOUT'
    || code === 'AGENT_RUNTIME_EXEC_FAILED'
    || code === 'AGENT_RESULT_MISSING'
    || code === 'AGENT_RESULT_INVALID';
}

export function errorContract(error: unknown): NatError {
  const code = errorCode(error);
  return {
    code,
    message: safeErrorMessage(error),
    retryable: isRetryable(code),
  };
}
