import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecording, MAX_RECORDING_SECONDS, MAX_WAV_BYTES } from '../src/wav.ts';

function wav(seconds: number): Buffer {
  const audio = Buffer.alloc(44 + seconds * 32000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); return audio;
}
test('held recordings longer than 20/30 seconds remain accepted up to the shared bound', () => {
  for (const seconds of [1, 21, 31, MAX_RECORDING_SECONDS]) assert.doesNotThrow(() => validateRecording(wav(seconds)));
  assert.equal(wav(MAX_RECORDING_SECONDS).length, MAX_WAV_BYTES);
});
test('oversize, wrong sample rate, and inconsistent WAV length are rejected before ASR', () => {
  assert.throws(() => validateRecording(wav(MAX_RECORDING_SECONDS + 1)), /INVALID_AUDIO/);
  const rate = wav(1); rate.writeUInt32LE(48000, 24); assert.throws(() => validateRecording(rate));
  const size = wav(1); size.writeUInt32LE(2, 40); assert.throws(() => validateRecording(size));
});
