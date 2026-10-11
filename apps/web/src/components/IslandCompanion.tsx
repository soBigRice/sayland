import { useId } from 'react';
import type { ComposerState } from './SceneShell.tsx';

/** A decorative, articulated version of the yellow sprout mascot; task state stays in useWorkshop. */
export function IslandCompanion({ state = 'idle' }: { state?: ComposerState }) {
  const id = useId();
  const paint = (name: string) => `url(#${id}-${name})`;
  return <svg className={`island-companion companion-${state}`} viewBox="0 0 180 180" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-body`} x1="0" y1="0" x2=".7" y2="1" gradientUnits="objectBoundingBox"><stop stopColor="#ffe784" /><stop offset=".55" stopColor="#ffd34c" /><stop offset="1" stopColor="#f6ae29" /></linearGradient>
      <linearGradient id={`${id}-side`} x2="1" y2="1"><stop stopColor="#ffc743" /><stop offset="1" stopColor="#ee961e" /></linearGradient>
      <linearGradient id={`${id}-leaf`} x2=".6" y2="1"><stop stopColor="#b5df5c" /><stop offset="1" stopColor="#78ae3a" /></linearGradient>
      <linearGradient id={`${id}-feet`} x2="0" y2="1"><stop stopColor="#91b86c" /><stop offset="1" stopColor="#668d48" /></linearGradient>
    </defs>
    <ellipse className="companion-shadow" cx="91" cy="165" rx="49" ry="7" fill="#5b713c" opacity=".12" />
    <g className="companion-body">
      <g className="companion-feet" fill={paint('feet')} stroke="#628b47" strokeWidth="1.2">
        <path d="M62 139h20v15c0 7-6 9-14 9H56c-6 0-7-6-3-10l9-6z" />
        <path d="M104 139h20v9l8 5c5 5 3 10-3 10h-12c-8 0-13-3-13-9z" />
      </g>
      <g className="companion-hand companion-hand-left">
        <path d="M45 96c-13 1-22 10-22 23 0 7 4 10 9 8l16-13" fill={paint('body')} stroke="#e8a039" strokeWidth="1.5" />
        <path d="m28 116 2 6" stroke="#fff0b1" strokeWidth="3" strokeLinecap="round" />
      </g>
      <g className="companion-hand companion-hand-right">
        <path d="M137 96c13 1 22 10 22 23 0 7-4 10-9 8l-16-13" fill={paint('body')} stroke="#e8a039" strokeWidth="1.5" />
        <path d="m153 116-2 6" stroke="#fff0b1" strokeWidth="3" strokeLinecap="round" />
      </g>
      <path d="m42 57 13-8 83 8c7 1 11 6 11 13v65c0 6-3 9-9 11l-13 5-81-14c-6-1-9-5-9-11V69c0-6 1-9 5-12z" fill={paint('side')} stroke="#e9a32c" strokeWidth="1.2" />
      <path d="m43 59 71-9c8-1 11 0 16 3l10 6-83 15z" fill="#fff0a0" />
      <path d="m58 68 73-9c8-1 14 4 14 12v61c0 8-4 12-12 13l-72 7c-8 1-13-4-13-12V81c0-8 3-12 10-13z" fill={paint('body')} stroke="#efb640" strokeWidth="1.2" />
      <path d="m60 73 71-9c4 0 6 1 7 3" fill="none" stroke="#fff5c6" strokeWidth="3" strokeLinecap="round" />
      <g className="companion-sprout">
        <path d="M93 57V37" stroke="#78a947" strokeWidth="8" strokeLinecap="round" />
        <path d="M91 44C69 47 63 35 65 23c18-1 29 6 28 19" fill={paint('leaf')} stroke="#83b443" strokeWidth="1.2" />
        <path d="M93 38c-2-18 11-26 27-23 0 17-9 26-27 23" fill={paint('leaf')} stroke="#83b443" strokeWidth="1.2" />
        <path d="m97 32 15-10M87 38 73 30" fill="none" stroke="#daed9c" strokeWidth="2" strokeLinecap="round" />
      </g>
      <g className="companion-face">
        <g className="companion-eyes" fill="#58452f">
          <rect x="72" y="94" width="9" height="16" rx="4.5" /><rect x="115" y="90" width="9" height="16" rx="4.5" />
          <g fill="#fff8e7"><circle cx="75" cy="97" r="1.7" /><circle cx="118" cy="93" r="1.7" /></g>
        </g>
        <g fill="#ed9760" opacity=".55"><ellipse cx="67" cy="116" rx="8" ry="4" /><ellipse cx="131" cy="110" rx="8" ry="4" /></g>
        {state === 'transcribing' || state === 'requesting'
          ? <ellipse cx="99" cy="121" rx="4" ry="5" fill="#875737" />
          : <path d={state === 'thinking' ? 'M94 124q5-3 9-1' : 'M89 120q10 12 20-2'} fill="none" stroke="#875737" strokeWidth="3.5" strokeLinecap="round" />}
      </g>
      {state === 'building' && <g className="companion-block"><path d="m136 125 13-6 14 7-13 7z" fill="#cee79d" /><path d="m136 125 14 8v15l-14-8z" fill="#93bd67" /><path d="m150 133 13-7v15l-13 7z" fill="#729f4c" /></g>}
    </g>
  </svg>;
}
