/**
 * ui.jsx - the primitives, written in the shadcn/ui style but hand-rolled.
 *
 * shadcn's model is "copy the component into your project, do not install it", so this is
 * that model taken literally: no component library dependency, no registry fetch, and the
 * whole design system is one readable file we own.
 */
import { useEffect, useRef, useState, createContext, useContext } from 'react'
import { X, Check, ChevronDown, Loader2 } from 'lucide-react'

export const cx = (...a) => a.filter(Boolean).join(' ')

/* ── Button ─────────────────────────────────────────────────────── */

const BTN = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover border-transparent',
  secondary: 'bg-surface text-foreground hover:bg-accent border-border-strong',
  ghost: 'bg-transparent text-muted hover:bg-accent hover:text-foreground border-transparent',
  danger: 'bg-danger text-white hover:opacity-90 border-transparent',
  soft: 'bg-primary-soft text-primary hover:brightness-95 border-transparent',
}
const SIZE = { sm: 'h-7 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', lg: 'h-10 px-4 text-sm gap-2', icon: 'h-8 w-8 justify-center' }

export function Button({ variant = 'secondary', size = 'md', className, loading, children, ...p }) {
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={cx('inline-flex items-center rounded-lg border font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        BTN[variant], SIZE[size], className)}>
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  )
}

/* ── Card ───────────────────────────────────────────────────────── */

export const Card = ({ className, ...p }) =>
  <div {...p} className={cx('rounded-xl border bg-surface', className)} />

export const CardHeader = ({ className, ...p }) =>
  <div {...p} className={cx('px-5 py-4 border-b flex items-center justify-between gap-3', className)} />

export const CardTitle = ({ className, ...p }) =>
  <h2 {...p} className={cx('font-semibold text-[15px] tracking-tight', className)} />

export const CardBody = ({ className, ...p }) =>
  <div {...p} className={cx('p-5', className)} />

/* ── Badge / pill ───────────────────────────────────────────────── */

const TONE = {
  neutral: 'bg-accent text-muted',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
}
export function Badge({ tone = 'neutral', className, dot, children }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
      'text-[11px] font-medium leading-5 whitespace-nowrap', TONE[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/* ── Form controls ──────────────────────────────────────────────── */

const FIELD = 'w-full rounded-lg border bg-surface px-3 text-sm text-foreground placeholder:text-faint ' +
  'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-60'

export const Input = ({ className, ...p }) =>
  <input {...p} className={cx(FIELD, 'h-9', className)} />

export const Textarea = ({ className, ...p }) =>
  <textarea {...p} className={cx(FIELD, 'py-2 leading-relaxed font-mono text-xs', className)} />

export function Select({ className, children, ...p }) {
  return (
    <div className="relative">
      <select {...p} className={cx(FIELD, 'h-9 appearance-none pr-8 cursor-pointer', className)}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint" />
    </div>
  )
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label}
      disabled={disabled} onClick={() => onChange?.(!checked)}
      className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-border-strong', disabled && 'opacity-50 pointer-events-none')}>
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-4.5 left-0.5' : 'translate-x-0 left-0.5')} />
    </button>
  )
}

export const Label = ({ className, hint, children }) => (
  <div className={cx('mb-1.5', className)}>
    <div className="text-xs font-medium text-foreground">{children}</div>
    {hint && <div className="text-[11px] text-faint mt-0.5 leading-snug">{hint}</div>}
  </div>
)

export const Field = ({ label, hint, children }) => (
  <div><Label hint={hint}>{label}</Label>{children}</div>
)

/* ── Tabs ───────────────────────────────────────────────────────── */

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cx('flex items-center gap-1 border-b px-1', className)} role="tablist">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('relative px-3 py-2.5 text-sm font-medium transition-colors',
            value === t.id ? 'text-foreground' : 'text-muted hover:text-foreground')}>
          {t.label}
          {t.count != null && <span className="ml-1.5 text-[11px] text-faint tabular">{t.count}</span>}
          {value === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
        </button>
      ))}
    </div>
  )
}

/* ── Table ──────────────────────────────────────────────────────── */

export const Table = ({ className, ...p }) => (
  <div className="overflow-x-auto">
    <table {...p} className={cx('w-full text-sm border-collapse', className)} />
  </div>
)
export const Th = ({ className, right, ...p }) =>
  <th {...p} className={cx('px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-faint',
    'border-b bg-surface-2 whitespace-nowrap', right ? 'text-right' : 'text-left', className)} />
export const Td = ({ className, right, ...p }) =>
  <td {...p} className={cx('px-4 py-3 border-b align-middle', right && 'text-right tabular', className)} />

/* ── Drawer (the Instantly "Setup / Configure / Test" panel) ────── */

export function Drawer({ open, onClose, title, subtitle, footer, width = 'max-w-2xl', children }) {
  useEffect(() => {
    if (!open) return
    const esc = e => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={onClose} />
      <aside className={cx('relative flex h-full w-full flex-col bg-surface border-l shadow-2xl animate-drawer', width)}>
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight truncate">{title}</h2>
            {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X size={16} /></Button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="border-t px-5 py-3 flex items-center justify-end gap-2 bg-surface-2">{footer}</footer>}
      </aside>
    </div>
  )
}

/* ── Confirm dialog (used before anything leaves the machine) ───── */

export function Confirm({ open, title, body, confirmLabel = 'Confirm', tone = 'primary',
                         secondaryLabel, secondaryTone = 'danger', onSecondary,
                         onConfirm, onClose, width = 'max-w-md' }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={cx('relative w-full rounded-xl border bg-surface shadow-2xl animate-in', width)}>
        <div className="px-5 pt-5 pb-3">
          <h3 className="font-semibold">{title}</h3>
          <div className="mt-2 text-sm text-muted leading-relaxed">{body}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-3 bg-surface-2 rounded-b-xl">
          <Button onClick={onClose}>Cancel</Button>
          {/* the spending / outward-facing option sits FIRST and away from the default,
              so the safe button stays where the thumb lands */}
          {secondaryLabel && <Button variant={secondaryTone} onClick={onSecondary}>{secondaryLabel}</Button>}
          <Button variant={tone} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  )
}

/* ── Feedback ───────────────────────────────────────────────────── */

export const Spinner = ({ size = 16, className }) =>
  <Loader2 size={size} className={cx('animate-spin text-faint', className)} />

export function Empty({ icon: Icon, title, body, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {Icon && <div className="mb-1 rounded-full bg-accent p-3 text-faint"><Icon size={20} /></div>}
      <div className="font-medium">{title}</div>
      {body && <div className="max-w-md text-sm text-muted leading-relaxed">{body}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular leading-none',
        tone === 'success' && 'text-success', tone === 'danger' && 'text-danger',
        tone === 'warning' && 'text-warning')}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

/* Inline note. `tone` carries the meaning, so a warning never reads as a failure. */
export function Note({ tone = 'neutral', icon: Icon, children, className }) {
  const ring = { neutral: 'border-border', primary: 'border-primary/30', success: 'border-success/30',
    warning: 'border-warning/40', danger: 'border-danger/40' }[tone]
  return (
    <div className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
      TONE[tone], ring, className)}>
      {Icon && <Icon size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/* ── Toasts ─────────────────────────────────────────────────────── */

const ToastCtx = createContext(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastHost({ children }) {
  const [items, setItems] = useState([])
  const idc = useRef(0)
  const push = (msg, tone = 'neutral') => {
    const id = ++idc.current
    setItems(x => [...x, { id, msg, tone }])
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 5200)
  }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
        {items.map(i => (
          <div key={i.id} className={cx('pointer-events-auto animate-in rounded-lg border bg-surface',
            'px-3.5 py-2.5 text-sm shadow-lg flex items-start gap-2')}>
            <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full',
              i.tone === 'success' ? 'bg-success' : i.tone === 'danger' ? 'bg-danger' :
              i.tone === 'warning' ? 'bg-warning' : 'bg-primary')} />
            <span className="min-w-0 break-words leading-snug">{i.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const CheckIcon = Check
