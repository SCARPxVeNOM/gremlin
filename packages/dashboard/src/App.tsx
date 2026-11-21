import { lazy, Suspense } from 'react'
import { Route, Routes, useLocation, Link } from 'react-router-dom'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandMenu } from '@/components/command-menu'
import { ThemeToggle } from '@/components/theme-toggle'
import { LiveIndicator } from '@/components/live-indicator'
import { Page } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { SNAPSHOT } from '@/lib/api'

const RELOADED = 'gremlin:reloaded-for-chunk'

/** A page chunk from an older build is gone after an upgrade: reload once to pick up the new build. */
function page(load: () => Promise<{ default: React.ComponentType<any> }>) {
  return lazy(() =>
    load().then(
      (mod) => {
        try {
          sessionStorage.removeItem(RELOADED)
        } catch {}
        return mod
      },
      (err) => {
        try {
          if (!sessionStorage.getItem(RELOADED)) {
            sessionStorage.setItem(RELOADED, '1')
            location.reload()
            return new Promise<never>(() => {})
          }
        } catch {}
        throw err
      },
    ),
  )
}

const Overview = page(() => import('@/pages/overview'))
const Flows = page(() => import('@/pages/flows'))
const FlowDetail = page(() => import('@/pages/flow-detail'))
const Bugs = page(() => import('@/pages/bugs'))
const BugDetail = page(() => import('@/pages/bug-detail'))
const Runs = page(() => import('@/pages/runs'))
const RunDetail = page(() => import('@/pages/run-detail'))
const Capture = page(() => import('@/pages/capture'))
const Breaker = page(() => import('@/pages/breaker'))
const Report = page(() => import('@/pages/report'))
const Settings = page(() => import('@/pages/settings'))
const NotFound = page(() => import('@/pages/not-found'))

function Loading() {
  return (
    <Page>
      <Skeleton className="mb-6 h-10 w-1/3" />
      <Skeleton className="h-96 rounded-xl" />
    </Page>
  )
}

const LABELS: Record<string, string> = {
  flows: 'Flows',
  bugs: 'Bugs',
  runs: 'Runs',
  capture: 'Capture',
  breaker: 'Breaker',
  report: 'Report',
  settings: 'Settings',
}

function Crumbs() {
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)
  if (!parts.length) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Overview</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
  }
  const section = parts[0]
  const rest = parts.slice(1).join('/')
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {rest ? (
          <>
            <BreadcrumbItem className="hidden md:block">
              <BreadcrumbLink asChild>
                <Link to={`/${section}`}>{LABELS[section] ?? section}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[40vw] truncate font-mono text-xs md:text-sm">{decodeURIComponent(rest)}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : (
          <BreadcrumbItem>
            <BreadcrumbPage>{LABELS[section] ?? section}</BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

export default function App() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {SNAPSHOT && (
          <div className="text-muted-foreground border-b px-4 py-2 text-xs">
            Gremlin's dashboard over a recorded session on the Kiln demo shop (18 Nov 2026): 43 real Kane CLI runs with their screenshots, the bugs, and Claude Code's
            fixes. Read-only, so the buttons that start Kane are off.{' '}
            <a className="text-foreground underline underline-offset-2" href="https://github.com/SCARPxVeNOM/gremlin">
              Run it yourself
            </a>
          </div>
        )}
        <header className="bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Crumbs />
          <div className="ml-auto flex items-center gap-2">
            <LiveIndicator />
            <CommandMenu />
            <ThemeToggle />
          </div>
        </header>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/flows" element={<Flows />} />
            <Route path="/flows/:type/:slug" element={<FlowDetail />} />
            <Route path="/bugs" element={<Bugs />} />
            <Route path="/bugs/:id" element={<BugDetail />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/capture" element={<Capture />} />
            <Route path="/breaker" element={<Breaker />} />
            <Route path="/report" element={<Report />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
