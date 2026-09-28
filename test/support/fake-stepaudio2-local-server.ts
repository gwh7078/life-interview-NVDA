import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeStepAudio2Server {
  url: string;
  close(): Promise<void>;
}

const capabilities = {
  fullDuplex: false,
  supportsInterrupt: false,
  supportsToolCalling: false,
  supportsContextInjection: true,
  supportsExplicitTurnRequest: true,
  supportsPlaybackAck: false,
  supportsExplicitSessionClose: true,
  manualTurnControl: true,
};

function send(ws: WebSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}

export async function startFakeStepAudio2Server(): Promise<FakeStepAudio2Server> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.on('connection', (ws) => {
    let speechStarted = false;
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === 'session.update') {
        send(ws, { type: 'session.capabilities', capabilities });
        send(ws, { type: 'session.updated', session: { id: 'fake-local', turn_detection: null } });
        return;
      }
      if (event.type === 'input_audio_buffer.append') {
        if (!speechStarted) {
          speechStarted = true;
          send(ws, { type: 'input_audio_buffer.speech_started', event_id: 'speech-1' });
        }
        return;
      }
      if (event.type === 'input_audio_buffer.commit') {
        speechStarted = false;
        send(ws, { type: 'input_audio_buffer.speech_stopped', event_id: 'speech-1' });
        send(ws, {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'user-1',
          transcript: '这是确定性的本地传输测试。',
        });
        return;
      }
      if (event.type === 'response.create') {
        send(ws, { type: 'response.created', response: { id: 'response-1', status: 'in_progress' } });
        send(ws, { type: 'response.audio_transcript.delta', response_id: 'response-1', delta: '继续。' });
        send(ws, { type: 'response.audio_transcript.done', response_id: 'response-1', transcript: '继续。' });
        send(ws, { type: 'response.audio.delta', response_id: 'response-1', delta: Buffer.alloc(960).toString('base64') });
        send(ws, { type: 'response.audio.done', response_id: 'response-1' });
        send(ws, { type: 'response.done', response: { id: 'response-1', status: 'completed' } });
        return;
      }
      if (event.type === 'session.close') {
        send(ws, { type: 'session.closed' });
        ws.close();
      }
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server did not expose a TCP address');
  return {
    url: `ws://127.0.0.1:${address.port}/realtime`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
