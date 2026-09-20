import { randomUUID } from 'node:crypto';
import {
  buildInterviewContextPayload,
  buildInterviewInstructions,
  type RealtimeInterviewContext
} from './prompt.js';
import { ONBOARDING_COMPLETION_UTTERANCE } from '../interview/onboarding/prompt.js';
import { isStoryGapQuestion } from '../story/gaps.js';
import { externalContributorRelationshipLabel } from '../interview/external-contributor/relationship.js';

export const DOUBAO_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
export const DOUBAO_MODEL_NAME = 'Seeduplex 1.0';
export const DEFAULT_DOUBAO_MODEL = '1.2.6.1';
export const DEFAULT_DOUBAO_VOICE = 'zh_female_vv_jupiter_bigtts';
// The second ID is exposed as a configurable candidate only; its compatibility
// with the Seeduplex 1.0 realtime endpoint has not been verified.
export const DOUBAO_CONFIGURABLE_VOICE_IDS = [
  DEFAULT_DOUBAO_VOICE,
  'zh_female_meilinvyou_uranus_bigtts',
] as const;
export const DOUBAO_INPUT_SAMPLE_RATE = 16_000;
export const DOUBAO_OUTPUT_SAMPLE_RATE = 24_000;
export const DOUBAO_OUTPUT_ENCODING = 'pcm_f32le';
export const DOUBAO_PCM_FRAME_BYTES = 640;
export const DOUBAO_ONBOARDING_COMPLETION_SENTINEL = '[[ONBOARDING_COMPLETE]]';
export const DOUBAO_END_SMOOTH_WINDOW_MS = 1_500;
const DOUBAO_ONBOARDING_COMPLETION_INSTRUCTIONS = `\n\n## Doubao 建档完成协议\n\n只有在首次建档目标全部达到时才结束采访。此时严格依次输出两部分：先仅向用户说出这句固定收尾语：“${ONBOARDING_COMPLETION_UTTERANCE}”；然后在单独一行输出精确标记 ${DOUBAO_ONBOARDING_COMPLETION_SENTINEL}。该标记只用于内部控制，绝不能朗读、解释或将其作为语音输出。不得在这两部分之外添加任何文字。`;

export interface DoubaoCredentials {
  apiKey: string;
}


export function buildDoubaoRealtimeHeaders(credentials: DoubaoCredentials): Record<string, string> {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey) throw new Error('VOLCENGINE_API_KEY is required.');
  return {
    'X-Api-Key': apiKey,
    'user-agent': 'rensheng-local-interview/0.1',
  };
}

export function buildDoubaoSessionCreate(
  context: RealtimeInterviewContext,
  options: { model?: string; voice?: string } = {},
): Record<string, unknown> {
  return {
    type: 'session.create',
    event_id: randomUUID(),
    session: {
      model: options.model?.trim() || DEFAULT_DOUBAO_MODEL,
      instructions: context.interview_type === 'onboarding'
        ? `${buildInterviewInstructions(context)}${DOUBAO_ONBOARDING_COMPLETION_INSTRUCTIONS}`
        : buildInterviewInstructions(context),
      audio: {
        input: { format: { type: 'pcm', rate: DOUBAO_INPUT_SAMPLE_RATE } },
        output: {
          format: { type: 'pcm', rate: DOUBAO_OUTPUT_SAMPLE_RATE },
          voice: options.voice?.trim() || DEFAULT_DOUBAO_VOICE,
        },
      },
      extension: {
        asr: {
          extra: {
            enable_asr_twopass: true,
            end_smooth_window_ms: DOUBAO_END_SMOOTH_WINDOW_MS,
          },
        },
      },
    },
  };
}

export function buildDoubaoOpeningGreetingText(context: RealtimeInterviewContext): string {
  if (context.interview_type === 'onboarding') {
    return context.taskContext.mode === 'new'
      ? '你好，很高兴认识你。我们先从你愿意讲的一段成长经历或人生变化开始，你最想先聊哪一段？'
      : '你好，我们继续上次的人生了解。你觉得接下来从哪一段经历继续聊最自然？';
  }
  if (context.interview_type === 'external_contributor') {
    const storyTitle = context.story.title.trim();
    const relationship = externalContributorRelationshipLabel(context.relationship);
    const subjectName = context.subject.name?.trim() || '故事主人公';
    const identity = `${subjectName}的${relationship}`;
    if (context.contributor_summary.trim()) {
      return storyTitle
        ? `你好，我们继续上次的采访。你是${identity}，这次接着从你的角度聊聊“${storyTitle}”。你最想先补充哪个细节？`
        : `你好，我们继续上次的采访。你是${identity}，这次接着从你的角度补充这段经历。你最想先说哪一点？`;
    }
    return storyTitle
      ? `你好，你是${identity}。想请你从你的角度补充“${storyTitle}”这段经历。作为${relationship}，你最先想到的是什么？`
      : `你好，你是${identity}。想请你从你的角度补充这段经历。作为${relationship}，你最先想到的是什么？`;
  }
  const storyTitle = typeof context.story?.title === 'string' ? context.story.title.trim() : '';
  const rawGaps = context.story?.gaps;
  const firstGap = Array.isArray(rawGaps)
    ? rawGaps.find(isStoryGapQuestion)?.trim() ?? ''
    : '';
  if (storyTitle) {
    if ((context.task_context?.mode ?? 'continue') === 'continue' && firstGap) {
      return `你好，我们接着聊“${storyTitle}”。${firstGap}`;
    }
    return `你好，我们接着聊聊“${storyTitle}”。关于这段经历，还有哪个细节你想再讲讲？`;
  }

  const targetTitle = typeof context.task_context?.target_title === 'string'
    ? context.task_context.target_title.trim()
    : '';
  if (targetTitle) return `你好，今天我们聊聊“${targetTitle}”。关于这段经历，你最先想起的是哪个具体场景？`;

  const stageTitle = typeof context.life_stage.title === 'string' ? context.life_stage.title.trim() : '';
  if (context.task_context?.mode === 'create' && stageTitle) {
    return `你好，今天我们先聊聊你在“${stageTitle}”时期的一段经历。你最先想起哪个具体场景？`;
  }

  return '你好，今天我们先聊聊一段你印象深刻的经历。你最先想起哪个具体场景？';
}

export function filterDoubaoOnboardingTranscript(text: string): {
  text: string;
  completionSignal: boolean;
} {
  const sentinel = DOUBAO_ONBOARDING_COMPLETION_SENTINEL;
  const trimmed = text.trimEnd();
  const markerStart = trimmed.lastIndexOf(sentinel);
  const strictSignal = markerStart >= 0
    && (markerStart === 0 || trimmed[markerStart - 1] === '\n')
    && trimmed.slice(markerStart + sentinel.length).trim().length === 0;
  let visibleText = text.replaceAll(sentinel, '');
  if (strictSignal) {
    visibleText = text.slice(0, markerStart).trimEnd();
  }
  return { text: visibleText, completionSignal: strictSignal };
}

/** Hides a sentinel prefix while a provider streams the final token in pieces. */
export function filterDoubaoOnboardingTranscriptPartial(text: string): string {
  const sentinel = DOUBAO_ONBOARDING_COMPLETION_SENTINEL;
  const markerStart = text.lastIndexOf('[[');
  if (markerStart >= 0) {
    const suffix = text.slice(markerStart);
    if (sentinel.startsWith(suffix)) return text.slice(0, markerStart).trimEnd();
  }
  // The marker may arrive starting with a single '['. Withhold any trailing
  // substring that could still grow into the sentinel until the next delta.
  for (let length = Math.min(sentinel.length - 1, text.length); length > 0; length -= 1) {
    if (sentinel.startsWith(text.slice(-length))) return text.slice(0, -length).trimEnd();
  }
  return text.replaceAll(sentinel, '').replace(/[ \t]+\n/g, '\n').trimEnd();
}

export function buildDoubaoTextCommit(text: string): Record<string, string> {
  const value = text.trim();
  if (!value) throw new Error('speech_text_buffer.commit requires non-empty text.');
  return { type: 'speech_text_buffer.commit', event_id: randomUUID(), text: value };
}

export function buildDoubaoAudioAppend(audio: Uint8Array): Record<string, string> {
  if (audio.byteLength === 0) throw new Error('input_audio_buffer.append requires audio data.');
  return {
    type: 'input_audio_buffer.append',
    event_id: randomUUID(),
    audio: Buffer.from(audio).toString('base64'),
  };
}

export function buildDoubaoAudioCommit(): Record<string, string> {
  return { type: 'input_audio_buffer.commit', event_id: randomUUID() };
}

export function buildDoubaoMuteInput(): Record<string, string> {
  return { type: 'input_audio_mute.commit', event_id: randomUUID() };
}

export function buildDoubaoSessionClose(): Record<string, string> {
  return { type: 'session.close', event_id: randomUUID() };
}

export function parseDoubaoServerEvent(raw: unknown): Record<string, unknown> | null {
  try {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf8');
    } else if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
      text = Buffer.concat(raw).toString('utf8');
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString('utf8');
    } else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    } else {
      return null;
    }

    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof (parsed as Record<string, unknown>).type !== 'string') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readDoubaoTranscriptionText(event: Record<string, unknown>): string {
  if (typeof event.text === 'string') return event.text;
  return typeof event.transcript === 'string' ? event.transcript : '';
}

export function resolveDoubaoAssistantTranscriptText(
  transcript: string,
  openingFallbackText?: string,
): { text: string; usedOpeningFallback: boolean } {
  if (transcript.trim()) return { text: transcript, usedOpeningFallback: false };
  if (openingFallbackText?.trim()) {
    return { text: openingFallbackText, usedOpeningFallback: true };
  }
  return { text: transcript, usedOpeningFallback: false };
}

export function normalizeDoubaoAssistantTranscriptEvent(
  event: Record<string, unknown>,
  responseId?: string,
): Record<string, unknown> | null {
  const type = String(event.type ?? '');
  const isDelta = type === 'response.audio_transcript.delta'
    || type === 'response.output_text.delta'
    || type === 'response.text.delta';
  const isDone = type === 'response.audio_transcript.done'
    || type === 'response.output_text.done'
    || type === 'response.text.done';
  if (!isDelta && !isDone) return null;

  const normalized: Record<string, unknown> = {
    ...event,
    type: isDelta ? 'response.audio_transcript.delta' : 'response.audio_transcript.done',
  };
  const resolvedResponseId = typeof event.response_id === 'string' ? event.response_id : responseId;
  if (resolvedResponseId) normalized.response_id = resolvedResponseId;
  if (isDone) {
    const text = typeof event.transcript === 'string'
      ? event.transcript
      : typeof event.text === 'string'
        ? event.text
        : undefined;
    if (text !== undefined) normalized.transcript = text;
  }
  return normalized;
}

export { buildInterviewContextPayload };
