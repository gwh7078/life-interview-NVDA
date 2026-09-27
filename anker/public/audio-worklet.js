class InterviewPcmResampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.frameSamples = processorOptions.frameSamples || 640;
    this.sourceSamples = [];
    this.outputSamples = [];
    this.readPosition = 0;
    this.step = sampleRate / this.targetSampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    for (let index = 0; index < channel.length; index += 1) {
      this.sourceSamples.push(channel[index]);
    }

    while (this.readPosition + 1 < this.sourceSamples.length) {
      const index = Math.floor(this.readPosition);
      const fraction = this.readPosition - index;
      const first = this.sourceSamples[index];
      const second = this.sourceSamples[index + 1];
      const sample = first + (second - first) * fraction;
      this.outputSamples.push(Math.max(-1, Math.min(1, sample)));
      this.readPosition += this.step;
    }

    const consumed = Math.min(Math.floor(this.readPosition), this.sourceSamples.length - 1);
    if (consumed > 0) {
      this.sourceSamples.splice(0, consumed);
      this.readPosition -= consumed;
    }

    while (this.outputSamples.length >= this.frameSamples) {
      const pcm = new Int16Array(this.frameSamples);
      for (let index = 0; index < this.frameSamples; index += 1) {
        const sample = this.outputSamples[index];
        pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      this.outputSamples.splice(0, this.frameSamples);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('interview-pcm-resampler', InterviewPcmResampler);
