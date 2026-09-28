import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import type { RealtimeInterviewContext } from '../../src/realtime/prompt.js';
import { parseStepfunServerEvent } from '../../src/realtime/stepfun.js';
import { createRealtimeInterviewProvider } from '../../src/realtime/provider.js';
import { resolveRealtimeProviderConfig } from '../../src/realtime/runtime-config.js';

type Event = Record<string, unknown>;
type Waiter = { predicate: (event: Event) => boolean; resolve: (event: Event) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const STORY_SUMMARY = '1978—1980年在店子集公社中学读高中，后来进入莒县一中继续学习。1983年参加高考，随后考入山东建筑材料工业学院。';
const AGENT_MEMORY = '用户来自山东莒县农村，高中阶段偏爱数理化，尤其喜欢化学。杨立苗老师与一次重要升学转折有关；王明晨是莒县一中班主任兼化学老师。不确定的信息不得补全，发现前后不一致时应自然核对。';
const TIMEOUT_MS = 20_000;

function row(value: unknown): Event | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Event : undefined;
}

function item(role: 'assistant' | 'user', text: string): Event {
  return { type: 'conversation.item.create', item: { type: 'message', role, content: [{ type: 'input_text', text }] } };
}

async function main(): Promise<void> {
  const model = process.env.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini';
  if (model !== 'step-audio-2-mini' || (process.env.STEPAUDIO2_EXECUTION?.trim() || 'stepfun-cloud') !== 'stepfun-cloud') {
    throw new Error('Canary requires Step-Audio-2-mini on StepFun Cloud.');
  }
  const config = resolveRealtimeProviderConfig('stepaudio2_mini', {
    region: 'cn-beijing',
    model: 'qwen3-omni-flash-realtime',
    stepfunApiKey: process.env.STEPFUN_API_KEY?.trim(),
    stepfunModel: model,
    stepaudio2Execution: 'stepfun-cloud',
  });
  const provider = createRealtimeInterviewProvider('stepaudio2_mini', config);
  const context: RealtimeInterviewContext = {
    interview_type: 'story',
    user: { user_id: randomUUID() },
    life_stage: { stage_id: randomUUID(), title: '高中求学', start_date: '1978', end_date: '1983' },
    story: {
      story_id: randomUUID(), title: '高中求学', summary: STORY_SUMMARY, agent_memory: AGENT_MEMORY,
      status: 'active', gaps: [],
    },
    task_context: { mode: 'continue' },
    voiceProfile: 'stepaudio2_mini',
    memoryTriggerMode: 'supervisor_auto',
  };
  const marker = `蓝鲸${randomBytes(8).toString('hex')}`;
  const canaryInput = `本轮连接测试标记是：${marker}。`;
  const responseInstruction = '只回复用户刚刚提供的测试标记，不要添加其他内容。';
  if (responseInstruction.includes(marker)) throw new Error('Canary marker leaked into response instructions.');

  const socket = new WebSocket(provider.connectOptions().url, {
    headers: provider.connectOptions().headers,
    handshakeTimeout: 15_000,
    maxPayload: 2 * 1024 * 1024,
  });
  const rawEvents: Event[] = [];
  const normalizedEvents: Event[] = [];
  const waiters: Waiter[] = [];
  let socketFailure: Error | undefined;
  let transcript = '';
  const waitFor = (events: Event[], predicate: (event: Event) => boolean, label: string): Promise<Event> => {
    if (socketFailure) return Promise.reject(socketFailure);
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`TIMEOUT_${label}`));
      }, TIMEOUT_MS);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const publish = (events: Event[], event: Event): void => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const fail = (error: Error): void => {
    socketFailure = error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  socket.on('message', (data) => {
    const raw = parseStepfunServerEvent(data);
    if (!raw || typeof raw.type !== 'string') return;
    publish(rawEvents, raw);
    for (const normalized of provider.normalizeServerMessage(data)) {
      const event = normalized as unknown as Event;
      publish(normalizedEvents, event);
      if (normalized.type === 'assistant.transcript.delta') transcript += normalized.delta;
      if (normalized.type === 'assistant.transcript.final') transcript = normalized.text;
      if (normalized.type === 'provider.error') fail(new Error('STEPFUN_PROVIDER_ERROR'));
    }
  });
  socket.on('error', () => fail(new Error('STEPFUN_SOCKET_ERROR')));
  socket.on('close', () => fail(new Error('STEPFUN_SOCKET_CLOSED')));

  const startedAt = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STEPFUN_CONNECT_TIMEOUT')), 15_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('STEPFUN_CONNECT_ERROR')); });
    });
    const configured = waitFor(normalizedEvents, (event) => event.type === 'session.configured', 'SESSION_CONFIGURED');
    for (const message of provider.setupSession(context)) socket.send(JSON.stringify(message));
    await configured;

    const priorQuestionAck = waitFor(rawEvents, (event) => {
      const created = row(event.item);
      return event.type === 'conversation.item.created' && created?.type === 'message'
        && created.role === 'assistant' && typeof created.id === 'string';
    }, 'PREVIOUS_QUESTION_ACK');
    socket.send(JSON.stringify(item('assistant', '你还记得正式高考是什么时候吗？')));
    await priorQuestionAck;

    const userAck = waitFor(rawEvents, (event) => {
      const created = row(event.item);
      return event.type === 'conversation.item.created' && created?.type === 'message'
        && created.role === 'user' && typeof created.id === 'string';
    }, 'USER_TEXT_ACK');
    socket.send(JSON.stringify(item('user', canaryInput)));
    const ack = await userAck;

    const responseDone = waitFor(normalizedEvents, (event) => event.type === 'response.done', 'RESPONSE_DONE');
    const requests = provider.requestAssistantTurnMessages(responseInstruction);
    if (requests.length !== 1 || JSON.stringify(requests[0]).includes(marker)) {
      throw new Error('CANARY_RESPONSE_INSTRUCTION_INVALID');
    }
    socket.send(JSON.stringify(requests[0]));
    const done = await responseDone;
    const response = row(row(rawEvents.findLast((event) => event.type === 'response.done'))?.response);
    if (!transcript.trim() && typeof done.finalText === 'string') transcript = done.finalText;
    const passed = transcript.includes(marker) && (done.status === 'completed' || response?.status === 'completed');
    process.stdout.write(`${JSON.stringify({
      result: passed ? 'PASS' : 'TEXT_USER_TURN_NOT_VERIFIED',
      model,
      input: canaryInput,
      acknowledgement: {
        event_type: ack.type,
        role: row(ack.item)?.role ?? null,
        content_types: Array.isArray(row(ack.item)?.content)
          ? (row(ack.item)?.content as Event[]).map((part) => part.type ?? null) : [],
        text_echoed: Array.isArray(row(ack.item)?.content)
          && (row(ack.item)?.content as Event[]).some((part) => typeof part.text === 'string'),
      },
      assistant_transcript: transcript.trim(),
      marker_found: transcript.includes(marker),
      latency_ms: Number((performance.now() - startedAt).toFixed(2)),
    })}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CANARY_FINISHED'));
    }
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
  }
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error && /^[A-Z0-9_]{1,96}$/u.test(error.message) ? error.message : 'UNKNOWN_ERROR';
  process.stderr.write(`TEXT_USER_TURN_NOT_VERIFIED (${detail})\n`);
  process.exitCode = 1;
});
