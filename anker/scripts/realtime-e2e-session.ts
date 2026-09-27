type RealtimeStartCommand = { type: 'start'; [key: string]: unknown };

export async function startRealtimeSession<T extends Record<string, unknown>>(
  socket: { send(data: string): void },
  startCommand: RealtimeStartCommand,
  waitForReady: () => Promise<T>,
): Promise<T> {
  socket.send(JSON.stringify(startCommand));
  const ready = await waitForReady();
  if (ready.type !== 'ready') throw new Error(`Expected Realtime ready, received ${String(ready.type)}.`);
  socket.send(JSON.stringify({ type: 'playback_ready' }));
  return ready;
}
