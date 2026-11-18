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

const Overview = lazy(() => import('@/pages/overview'))
const Flows = lazy(() => import('@/pages/flows'))
const FlowDetail = lazy(() => import('@/pages/flow-detail'))
const Bugs = lazy(() => import('@/pages/bugs'))
const BugDetail = lazy(() => import('@/pages/bug-detail'))
const Runs = lazy(() => import('@/pages/runs'))
const RunDetail = lazy(() => import('@/pages/run-detail'))
const Capture = lazy(() => import('@/pages/capture'))
const Breaker = lazy(() => import('@/pages/breaker'))
const Report = lazy(() => import('@/pages/report'))
const Settings = lazy(() => import('@/pages/settings'))
const NotFound = lazy(() => import('@/pages/not-found'))

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
