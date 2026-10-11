class SaylandRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(4096); this.offset = 0;
    this.port.onmessage = ({ data }) => { if (data === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); } };
  }
  flush() { if (this.offset) { const chunk = this.buffer.slice(0, this.offset); this.port.postMessage({ type: 'samples', samples: chunk }, [chunk.buffer]); this.offset = 0; } }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (let i = 0; i < input.length; i++) { this.buffer[this.offset++] = input[i]; if (this.offset === this.buffer.length) this.flush(); }
    return true;
  }
}
registerProcessor('sayland-recorder', SaylandRecorder);
