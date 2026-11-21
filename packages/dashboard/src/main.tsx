import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { LiveProvider } from '@/lib/live'
import { SNAPSHOT } from '@/lib/api'
import App from './App.tsx'
import './index.css'

// A static host has no fallback to index.html for deep links, so the snapshot routes through the hash.
const Router = SNAPSHOT ? HashRouter : BrowserRouter

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={200}>
        <Router>
          <LiveProvider>
            <App />
            <Toaster position="bottom-right" />
          </LiveProvider>
        </Router>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
