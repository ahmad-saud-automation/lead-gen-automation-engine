import { useEffect, useState } from 'react'
import {
  LayoutList, ClipboardCheck, Activity, Columns3, Settings as Cog, Moon, Sun, Zap,
} from 'lucide-react'
import { Button, cx } from './components/ui.jsx'
import Campaigns from './pages/Campaigns.jsx'
import Plan from './pages/Plan.jsx'
import RunView from './pages/RunView.jsx'
import FieldMap from './pages/FieldMap.jsx'
import Settings from './pages/Settings.jsx'

const NAV = [
  { id: 'campaigns', label: 'Campaigns', icon: LayoutList },
  { id: 'plan', label: 'Plan preview', icon: ClipboardCheck },
  { id: 'run', label: 'Runs', icon: Activity },
  { id: 'fieldmap', label: 'Field map', icon: Columns3 },
  { id: 'settings', label: 'Settings', icon: Cog },
]

/** Hash routing: no router dependency, and a screen is still linkable. */
function useRoute() {
  const read = () => {
    const [page = 'campaigns', arg = ''] = window.location.hash.replace(/^#\/?/, '').split('/')
    return { page: NAV.some(n => n.id === page) ? page : 'campaigns', arg }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const go = (page, arg) => { window.location.hash = `#/${page}${arg ? '/' + arg : ''}` }

export default function App() {
  const { page, arg } = useRoute()
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem('leadgen.theme', dark ? 'dark' : 'light') } catch { /* ignore */ }
  }, [dark])

  const current = NAV.find(n => n.id === page)

  return (
    <div className="flex h-full">
      {/* icon rail - the pattern from Instantly's own left bar */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-surface py-3">
        <div className="mb-3 grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Zap size={16} />
        </div>
        {NAV.map(n => (
          <button key={n.id} onClick={() => go(n.id)} title={n.label} aria-label={n.label}
            className={cx('grid h-9 w-9 place-items-center rounded-lg transition-colors',
              page === n.id ? 'bg-primary-soft text-primary' : 'text-faint hover:bg-accent hover:text-foreground')}>
            <n.icon size={17} />
          </button>
        ))}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={() => setDark(d => !d)}
          title={dark ? 'Light mode' : 'Dark mode'} aria-label="Toggle theme">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </Button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-6">
          <h1 className="text-[15px] font-semibold tracking-tight">{current?.label}</h1>
          <span className="text-xs text-faint">Lead Gen Automation Engine</span>
          <div className="flex-1" />
          <a href="/legacy" className="text-xs text-faint hover:text-foreground hover:underline"
            title="The original V1 interface, kept as a fallback">old interface</a>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] p-6">
            {page === 'campaigns' && <Campaigns />}
            {page === 'plan' && <Plan />}
            {page === 'run' && <RunView runId={arg} />}
            {page === 'fieldmap' && <FieldMap />}
            {page === 'settings' && <Settings />}
          </div>
        </main>
      </div>
    </div>
  )
}
