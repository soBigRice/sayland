import { useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown, ChevronLeft, ChevronUp } from 'lucide-react';

// Time-based spring keeps panel travel legible without slowing down press feedback.
export const panelSpring = { type: 'spring' as const, duration: 0.85, bounce: 0 };

interface FloatingPanelProps {
  name: string;
  label: string;
  icon: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  hidden?: boolean;
  active?: boolean;
  summary?: string;
}

/** Keep live form/log content mounted; animate a separate surface so text never stretches. */
export function FloatingPanel({ name, label, icon, children, collapsed, onToggle, hidden = false, active = false, summary }: FloatingPanelProps) {
  const contentId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  const closed = collapsed || hidden;
  const transition = reduced ? { duration: 0 } : panelSpring;
  function collapse() {
    toggle.current?.focus({ preventScroll: true });
    onToggle();
  }
  return <div className={`floating-region panel-${name} ${closed ? 'is-collapsed' : ''} ${hidden ? 'is-hidden' : ''}`}
    data-panel={name} data-collapsed={collapsed} inert={hidden} aria-hidden={hidden || undefined}
    onKeyDown={event => {
      if (event.key !== 'Escape' || closed || event.defaultPrevented || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.stopPropagation(); collapse();
    }}>
    <motion.div className="floating-surface" layout initial={false} aria-hidden="true"
      style={{ borderRadius: closed ? 28 : 22 }} transition={transition}
      animate={{ opacity: hidden ? 0 : 1 }} />
    <motion.div id={contentId} className="floating-content" inert={closed} aria-hidden={closed || undefined}
      initial={false} animate={{ opacity: closed ? 0 : 1, y: reduced ? 0 : closed ? (name === 'composer' || name === 'suggestions' ? 8 : -6) : 0 }}
      transition={{ duration: reduced ? 0 : closed ? 0.28 : 0.45, delay: closed || reduced ? 0 : 0.12, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
    <motion.button ref={toggle} type="button" layout initial={false}
      className={`panel-toggle ${active ? 'has-activity' : ''}`} style={{ borderRadius: collapsed ? 28 : 18 }}
      aria-controls={contentId} aria-expanded={!collapsed} aria-label={`${collapsed ? '展开' : '收起'}${label}${collapsed && summary ? `，${summary}` : ''}`}
      title={collapsed ? summary || `展开${label}` : `收起${label}`} onClick={collapse}
      animate={{ opacity: hidden ? 0 : 1, scale: hidden && !reduced ? 0.85 : 1 }}
      transition={transition} whileHover={reduced ? undefined : { scale: 1.055, transition: { duration: 0.18 } }} whileTap={reduced ? undefined : { scale: 0.94, transition: { duration: 0.1 } }}>
      <AnimatePresence initial={false} mode="sync">
        <motion.span key={collapsed ? 'compact' : 'fold'} className="panel-toggle-symbol"
          initial={{ opacity: 0, scale: reduced ? 1 : 0.8 }} animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: reduced ? 1 : 0.8 }} transition={{ duration: reduced ? 0 : 0.25 }}>
          {collapsed ? icon : name === 'composer' || name === 'suggestions'
            ? <ChevronDown aria-hidden="true" /> : name === 'header'
              ? <ChevronUp aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
        </motion.span>
      </AnimatePresence>
      {collapsed && active && <span className="panel-activity-dot" aria-hidden="true" />}
    </motion.button>
  </div>;
}
