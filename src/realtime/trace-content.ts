export const REALTIME_TRACE_CONTENT_KINDS = [
  'coach.gate.input',
  'coach.gate.output',
  'coach.gate.prompt',
  'coach.resolve.input',
  'coach.resolve.output',
  'coach.resolve.prompt',
  'coach.mini_packet',
  'coach.response_instructions',
  'session.farewell_instructions',
  'session.wrapup_instructions',
] as const;

export type RealtimeTraceContentKind = typeof REALTIME_TRACE_CONTENT_KINDS[number];

export interface PreparedRealtimeTraceContent {
  content: string;
  format: 'text' | 'json';
  chars: number;
  bytes: number;
  redacted: boolean;
  truncated: boolean;
}

const SECRET_FIELD_KEY = /(?:^|[_-])(?:api[_-]?keys?|(?:api|access|refresh|id|session|auth|bearer)?[_-]?token|authorization|password|client[_-]?secret|private[_-]?key|secret[_-]?key|cookie|credentials?)(?:$|[_-])|(?:ApiKeys?|(?:Api|Access|Refresh|Id|Session|Auth|Bearer)?Tokens?|Authorization|Password|ClientSecret|PrivateKey|SecretKey|Secret|Cookie|Credential)$/iu;

const SECRET_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]'],
  [/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/giu, '[REDACTED]'],
  [/(["']?(?:api[_-]?keys?|(?:api|access|refresh|id|session|auth|bearer)?[_-]?tokens?|authorization|password|client[_-]?secret|private[_-]?key|secret[_-]?key|cookie|credentials?)["']?\s*[:=]\s*["']?)[^"'`\s,;\]}]+/giu, '$1[REDACTED]'],
  [/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, '$1[REDACTED]@'],
];

function redactText(value: string): { text: string; redacted: boolean } {
  let text = value;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    const next = text.replace(pattern, replacement);
    if (next !== text) text = next;
  }
  return { text, redacted: text !== value };
}

function boundedText(value: string, maxBytes: number): Pick<PreparedRealtimeTraceContent, 'content' | 'chars' | 'bytes' | 'truncated'> {
  let content = '';
  let chars = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      return { content, chars, bytes, truncated: true };
    }
    content += character;
    chars += 1;
    bytes += characterBytes;
  }
  return { content, chars, bytes, truncated: false };
}

export function prepareRealtimeTraceContent(value: unknown, maxBytes: number): PreparedRealtimeTraceContent | undefined {
  let format: PreparedRealtimeTraceContent['format'];
  let serialized: string;
  if (typeof value === 'string') {
    format = 'text';
    serialized = value;
  } else {
    format = 'json';
    let redactedField = false;
    try {
      const json = JSON.stringify(value, (key, entry: unknown) => {
        if (key && SECRET_FIELD_KEY.test(key) && entry !== null && entry !== undefined) {
          redactedField = true;
          return '[REDACTED]';
        }
        return entry;
      });
      if (json === undefined) return undefined;
      serialized = json;
      const redacted = redactText(serialized);
      return {
        ...boundedText(redacted.text, maxBytes),
        format,
        redacted: redactedField || redacted.redacted,
      };
    } catch {
      return undefined;
    }
  }

  const redacted = redactText(serialized);
  return {
    ...boundedText(redacted.text, maxBytes),
    format,
    redacted: redacted.redacted,
  };
}
