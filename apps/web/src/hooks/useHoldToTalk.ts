import { useEffect, useRef } from 'react';
import { HoldToTalk } from '../lib/holdToTalk.ts';

export function useHoldToTalk(options: { enabled: boolean; canStart: boolean; start(): void; send(): void; cancel(): void }) {
  const current = useRef(options); current.current = options;
  const control = useRef<HoldToTalk | null>(null);
  if (!control.current) control.current = new HoldToTalk({
    canStart: () => current.current.enabled && current.current.canStart,
    start: () => current.current.start(), send: () => current.current.send(), cancel: () => current.current.cancel(),
  });
  const hold = control.current;
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { hold.cancel(); return; }
      if (event.code === 'Space' && hold.owns('space')) { event.preventDefault(); return; }
      if (event.code !== 'Space' || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]')) return;
      if (target?.closest('button, a[href], [role="button"], [role="slider"], [role="combobox"]') && !target.closest('[data-hold-to-talk]')) return;
      if (hold.begin('space')) event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      // Release the owner even if focus moved or a modifier was pressed during the hold.
      if (event.code === 'Space' && hold.end('space')) event.preventDefault();
    };
    const cancel = () => hold.cancel();
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', visibility);
      cancel();
    };
  }, [hold]);
  useEffect(() => { if (!options.enabled) hold.cancel(); }, [hold, options.enabled]);
  return hold;
}
