import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { ToastHost } from './components/ui.jsx'
import './index.css'

// Restore the theme before first paint so the app never flashes light then dark.
try {
  if (localStorage.getItem('leadgen.theme') === 'dark') document.documentElement.classList.add('dark')
} catch { /* private mode - the default light theme is fine */ }

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ToastHost><App /></ToastHost>
  </StrictMode>
)
