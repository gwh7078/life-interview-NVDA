# Realtime interview diagnostics

Each interview session writes a timestamped JSONL trace under the unified diagnostics root:

```text
runtime/diagnostics/traces/realtime/<session id>.jsonl
```

The diagnostics root defaults to `./runtime/diagnostics` and can be relocated with `DIAGNOSTICS_DIR`. The session ID is also shown in the interview page after connection. The directory is created with owner-only permissions, and old realtime trace files are pruned to keep the latest 30. Raw transcript text, audio, microphone samples and API keys are not written to the realtime trace.

Each row has a UTC `at` timestamp and a monotonic `elapsed_ms`. Browser-originated rows also include `clientElapsedMs`, measured from pressing Start. This makes provider and browser events comparable without depending on wall-clock precision.

The trace records provider response/audio events and byte counts, browser audio-chunk receipt and scheduling results, AudioContext state and latency, microphone frame/byte totals in roughly one-second windows, transcript write counts and durations, and aggregated mouse-wheel activity. Browser audio scheduling entries also include per-chunk PCM peak/RMS, the sample jump at chunk boundaries, tail-sample magnitude, and counts of clipped or non-finite samples. These are scalar diagnostics only: the trace does not record transcript text, audio, microphone samples, API keys, exact sample values, or scroll coordinates.

For a missing or inaudible interviewer response, inspect events in this order:

1. `provider.response_created` and `provider.audio_delta` show whether the provider started a response and returned audio bytes.
2. `client.output_audio_chunk` and `client.output_audio_scheduled` show whether the browser received each chunk and scheduled it. A `scheduled: false` result includes a short reason; `audio_decode_error` and `audio_playback_error` identify client-side failures.
3. `client.output_audio_summary` totals chunks, bytes, drops, timing gaps, and the final audio context state.
   `maxBoundaryJump` and `terminalSampleAbs` help distinguish chunk/tail discontinuities from provider delivery problems; unusually high values near the reported beep point to a playback-boundary artifact.
4. `client.microphone_uplink` shows whether mic frames reached the local service. Zero frames points to browser capture/worklet/session flow; nonzero frames with no ASR events points farther downstream.
5. `client.scroll_activity` records wheel-event counts alongside whether a response was active and how many playback nodes were pending, so it can be compared with audio scheduling gaps.

For speech-end timing, compare `provider.input_audio_buffer.committed_received` / `_forwarded` and `provider.input_audio_buffer.speech_stopped_received` / `_forwarded` with `client.speech_stopped_received`. These are raw provider event receipt and browser-forwarding markers. The client event includes a `source` (`committed` or `speech_stopped`) and the browser receive time. User ASR progress is recorded as `provider.user_transcription_delta_received` / `_forwarded` and `client.user_partial` / `client.user_partial_rendered`; final ASR completion and forwarding are `provider.user_transcription_completed` / `_forwarded`, followed by the corresponding client `user_final` rows. Assistant text is recorded as `provider.assistant_transcript_delta_received` / `_forwarded`, `provider.assistant_transcript_done_received`, and `provider.assistant_transcript_final_forwarded`, alongside client delta/final `received` and `rendered` rows. Transcript rows contain only character/count metadata, never the transcript text. A client `rendered` event means the page's DOM text field was assigned and read back by JavaScript; it does not prove that pixels were painted or that the user saw them.

Provider speech/ASR markers also carry `micPacketCount` and `micPacketAgeMs`, which describe how many mic packets the local server accepted and the age of the most recent packet at that point. Browser speech-start, speech-stop, and ASR-partial receipt markers carry the same measurements for packets sent from that browser. This app has no local speech/silence classifier: packet activity alone cannot distinguish speech from silence, and this instrumentation does not inspect or retain microphone samples or compute mic RMS/peak values. Thus it separates packet-flow gaps from provider endpointing delays, but local VAD timing remains unknown. `client.output_audio_node_start_called` is recorded immediately after `AudioBufferSourceNode.start(when)` is called; `scheduledContextTimeMs` is its target AudioContext time, while `contextTimeMs` is the context time at the call. `client.output_audio_node_ended` is recorded by the node's `ended` callback. Its `contextElapsedSinceScheduledStartMs` is the AudioContext time at that callback minus the scheduled start time, so it includes any delay dispatching the callback after playback ended. `nodeLifetimeMs` is wall-clock time from the `start()` call to the callback and also includes any schedule-ahead wait. These values describe browser scheduling and Web Audio node lifecycle, not when sound physically reached the speaker or stopped being audible.

This trace diagnoses software delivery and scheduling. It cannot confirm the selected physical output device or whether sound was audible in the room.

Seeduplex 1.0's full-duplex endpoint currently returns `audio.output.format.type: "pcm"` as 24 kHz mono Float32 little-endian samples. A generic integration guide also describes a PCM16 TTS extension, but a live byte-distribution probe showed that this endpoint ignores that override and continues to return Float32. The browser therefore decodes Doubao audio as `pcm_f32le`; Qwen keeps its separate PCM16 path.
