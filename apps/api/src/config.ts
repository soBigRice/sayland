import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ApiConfig {
  port: number;
  allowedOrigins: string[];
  deepseek: { apiKey: string; baseUrl: string; model: string };
  mimo: { apiKey: string; baseUrl: string; asrModel: string; ttsModel: string; voice: string };
}

/** Only the Sayland root file is read. Source project credentials are never discovered here. */
export function loadConfig(projectRoot = process.cwd(), environment = process.env): ApiConfig {
  let local: Record<string, string> = {};
  try {
    local = parseEnvironment(readFileSync(resolve(projectRoot, '.env.local'), 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new Error('Unable to read Sayland .env.local');
    }
  }
  const value = (name: string, fallback = '') => environment[name]?.trim() || local[name]?.trim() || fallback;
  const port = Number(value('SAYLAND_API_PORT', '4311'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SAYLAND_API_PORT');
  const allowedOrigins = value('SAYLAND_WEB_ORIGINS', 'http://127.0.0.1:4310,http://localhost:4310')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.origin !== origin) throw new Error('SAYLAND_WEB_ORIGINS must contain exact loopback HTTP origins');
  }
  return {
    port, allowedOrigins,
    deepseek: {
      apiKey: value('DEEPSEEK_API_KEY'),
      baseUrl: providerBase(value('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'), 'api.deepseek.com'),
      model: value('DEEPSEEK_MODEL', value('DEEPSEEK_TEXT_MODEL', 'deepseek-flash')),
    },
    mimo: {
      apiKey: value('MIMO_API_KEY'),
      baseUrl: providerBase(value('MIMO_BASE_URL', 'https://api.xiaomimimo.com/v1'), 'api.xiaomimimo.com'),
      asrModel: 'mimo-v2.5-asr',
      ttsModel: 'mimo-v2.5-tts',
      voice: value('MIMO_TTS_VOICE', 'mimo_default'),
    },
  };
}

function providerBase(input: string, host: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL must use the official HTTPS endpoint');
  }
  return url.href.replace(/\/+$/, '');
}

function parseEnvironment(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    result[match[1]] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, '');
  }
  return result;
}
