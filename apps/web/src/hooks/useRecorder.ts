import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_RECORDING_SECONDS } from '../../../../packages/protocol/src/voice.ts';

interface Capture {
  stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode; gain: GainNode; chunks: Float32Array[]; frames: number;
  timer: ReturnType<typeof setInterval>; flush?: () => void;
}
export function useRecorder(onLimit: () => void) {
  const active = useRef<Capture | null>(null);
  const pending = useRef<{ stream?: MediaStream; context?: AudioContext } | null>(null);
  const starting = useRef(false), generation = useRef(0), limit = useRef(onLimit);
  limit.current = onLimit;
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const release = useCallback((capture: Capture) => {
    clearInterval(capture.timer); capture.node.port.onmessage = null;
    capture.source.disconnect(); capture.node.disconnect(); capture.gain.disconnect();
    capture.stream.getTracks().forEach(track => track.stop());
    void capture.context.close().catch(() => undefined);
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    pending.current?.stream?.getTracks().forEach(track => track.stop());
    const context = pending.current?.context;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    const capture = active.current; active.current = null;
    if (capture) { capture.flush?.(); release(capture); }
    setRecording(false); setElapsed(0);
  }, [release]);
  const start = useCallback(async () => {
    if (active.current || starting.current) return false;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('这个浏览器暂不支持录音，可以先打字创作。');
    starting.current = true; const id = ++generation.current;
    const resources: NonNullable<typeof pending.current> = {}; pending.current = resources;
    let stream: MediaStream | null = null, context: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      resources.stream = stream;
      if (generation.current !== id) { stream.getTracks().forEach(t => t.stop()); return false; }
      context = new AudioContext();
      resources.context = context;
      await context.audioWorklet.addModule('/recorder.worklet.js');
      if (generation.current !== id) return false;
      await context.resume();
      if (generation.current !== id) { stream.getTracks().forEach(t => t.stop()); await context.close(); return false; }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'sayland-recorder');
      const gain = context.createGain(); gain.gain.value = 0;
      source.connect(node); node.connect(gain); gain.connect(context.destination);
      const started = performance.now();
      const capture: Capture = { stream, context, source, node, gain, chunks: [], frames: 0, timer: setInterval(() => {
        const seconds = Math.floor((performance.now() - started) / 1000); setElapsed(seconds);
        if (seconds >= MAX_RECORDING_SECONDS) { clearInterval(capture.timer); limit.current(); }
      }, 250) };
      node.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        if (data.type === 'flushed') capture.flush?.();
        if (data.samples) {
          const remaining = context!.sampleRate * MAX_RECORDING_SECONDS - capture.frames;
          if (remaining > 0) { const samples = data.samples.slice(0, remaining); capture.chunks.push(samples); capture.frames += samples.length; }
        }
      };
      active.current = capture; setElapsed(0); setRecording(true); return true;
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop()); if (context && context.state !== 'closed') await context.close();
      throw error instanceof DOMException && error.name === 'NotAllowedError' ? new Error('没有获得麦克风权限。允许录音后再试，或直接打字。') : error;
    } finally { starting.current = false; if (pending.current === resources) pending.current = null; }
  }, []);
  const stop = useCallback(async (): Promise<Blob | null> => {
    const capture = active.current;
    if (!capture) return null;
    active.current = null; setRecording(false); clearInterval(capture.timer);
    capture.stream.getTracks().forEach(track => track.stop());
    try {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 400);
        capture.flush = () => { clearTimeout(timeout); resolve(); };
        capture.node.port.postMessage('flush');
      });
      if (capture.frames < capture.context.sampleRate * 0.25) throw new Error('刚才有点短，再说一句试试看。');
      const buffer = capture.context.createBuffer(1, capture.frames, capture.context.sampleRate);
      let offset = 0; for (const chunk of capture.chunks) { buffer.getChannelData(0).set(chunk, offset); offset += chunk.length; }
      const resampler = new OfflineAudioContext(1, Math.ceil(capture.frames * 16000 / capture.context.sampleRate), 16000);
      const source = resampler.createBufferSource(); source.buffer = buffer; source.connect(resampler.destination); source.start();
      const audio = (await resampler.startRendering()).getChannelData(0);
      const wav = new ArrayBuffer(44 + audio.length * 2), view = new DataView(wav);
      const word = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
      word(0, 'RIFF'); view.setUint32(4, 36 + audio.length * 2, true); word(8, 'WAVE'); word(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      word(36, 'data'); view.setUint32(40, audio.length * 2, true);
      for (let i = 0; i < audio.length; i++) { const value = Math.max(-1, Math.min(1, audio[i])); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true); }
      return new Blob([wav], { type: 'audio/wav' });
    } finally { release(capture); setElapsed(0); }
  }, [release]);
  useEffect(() => cancel, [cancel]);
  return { recording, elapsed, start, stop, cancel, isRecording: () => active.current !== null };
}
