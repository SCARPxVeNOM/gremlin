import { Link, useLocation } from 'react-router-dom'
import { Bug, ClipboardPaste, Compass, FileText, Gauge, History, Route, Settings, ShieldCheck, Swords } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { Logo } from './logo'
import { useQuery } from '@/lib/live'
import { SNAPSHOT, type Summary } from '@/lib/api'

// a recording opens on its story, and the dashboard's own front page moves to /overview
const nav = [
  ...(SNAPSHOT ? [{ label: 'Recorded session', items: [{ to: '/', label: 'Start here', icon: Compass }] }] : []),
  {
    label: 'Library',
    items: [
      { to: SNAPSHOT ? '/overview' : '/', label: 'Overview', icon: Gauge },
      { to: '/flows', label: 'Flows', icon: Route },
      { to: '/bugs', label: 'Bugs', icon: Bug, badge: 'open' as const },
      { to: '/runs', label: 'Runs', icon: History },
    ],
  },
  {
    label: 'Loops',
    items: [
      { to: '/breaker', label: 'Breaker', icon: Swords },
      { to: '/capture', label: 'Capture', icon: ClipboardPaste },
      { to: '/report', label: 'Report', icon: FileText },
    ],
  },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  const { data } = useQuery<Summary>('summary')
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Logo className="size-5" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Gremlin</span>
                  <span className="text-muted-foreground truncate text-xs">{SNAPSHOT ? `Recorded on ${data?.app.name ?? 'Kiln'}` : (data?.app.name ?? 'QA that never sleeps')}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {nav.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={isActive(item.to)} tooltip={item.label}>
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {'badge' in item && data && data.counts.open > 0 && <SidebarMenuBadge>{data.counts.open}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive('/settings')} tooltip="Settings">
              <Link to="/settings">
                <Settings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-xs group-data-[collapsible=icon]:hidden">
              <ShieldCheck className="size-3.5" />
              Verified by Kane CLI
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
