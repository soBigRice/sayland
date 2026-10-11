import { ApiError } from './errors.ts';
import { MAX_RECORDING_SECONDS } from '../../../packages/protocol/src/voice.ts';

export { MAX_RECORDING_SECONDS };
export const MAX_WAV_BYTES = 44 + 32_000 * MAX_RECORDING_SECONDS;

/** Validate sample count, not caller-provided duration, before uploading any audio. */
export function validateRecording(audio: Buffer): void {
  const invalid = () => new ApiError('INVALID_AUDIO', 400, `请使用不超过 ${MAX_RECORDING_SECONDS} 秒的单声道 16 kHz WAV 录音。`);
  if (audio.length < 44 || audio.length > MAX_WAV_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) !== audio.length - 8) throw invalid();
  let formatSeen = false;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset < audio.length) {
    if (offset + 8 > audio.length) throw invalid();
    const name = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const begin = offset + 8;
    const end = begin + size + size % 2;
    if (end > audio.length) throw invalid();
    if (name === 'fmt ') {
      if (formatSeen || (size !== 16 && size !== 18) || audio.readUInt16LE(begin) !== 1
        || audio.readUInt16LE(begin + 2) !== 1 || audio.readUInt32LE(begin + 4) !== 16000
        || audio.readUInt32LE(begin + 8) !== 32000 || audio.readUInt16LE(begin + 12) !== 2
        || audio.readUInt16LE(begin + 14) !== 16 || (size === 18 && audio.readUInt16LE(begin + 16) !== 0)) throw invalid();
      formatSeen = true;
    } else if (name === 'data') {
      if (!formatSeen || dataBytes !== undefined || size < 2 || size % 2 !== 0) throw invalid();
      dataBytes = size;
    } else if (name === 'LIST' && size >= 4 && audio.toString('ascii', begin, begin + 4) === 'wavl') {
      throw invalid();
    }
    offset = end;
  }
  if (!formatSeen || dataBytes === undefined || dataBytes > 32000 * MAX_RECORDING_SECONDS) throw invalid();
}
