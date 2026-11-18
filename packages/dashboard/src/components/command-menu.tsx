import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bug, ClipboardPaste, FileText, Gauge, History, Route, Search, Settings, ShieldCheck, Swords } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { useQuery } from '@/lib/live'
import { post, type Bug as BugT, type FlowView } from '@/lib/api'
import { StatusIcon } from './status'
import { Kbd } from './page'

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { data: flows } = useQuery<FlowView[]>(open ? 'flows' : null)
  const { data: bugs } = useQuery<BugT[]>(open ? 'bugs' : null)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement))) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }
  const act = async (path: string, label: string) => {
    setOpen(false)
    try {
      await post(path, path === 'guard' ? { all: true } : {})
      toast.success(label)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        className="bg-muted/50 text-muted-foreground relative h-8 w-full justify-start rounded-md pr-12 pl-2.5 text-sm font-normal shadow-none sm:w-48 lg:w-60"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5" />
        <span className="hidden lg:inline-flex">Search flows and bugs…</span>
        <span className="inline-flex lg:hidden">Search…</span>
        <span className="absolute top-1/2 right-1.5 -translate-y-1/2">
          <Kbd>⌘K</Kbd>
        </span>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Command menu" description="Jump to a flow, a bug or an action">
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Go to">
            {[
              { to: '/', label: 'Overview', icon: Gauge },
              { to: '/flows', label: 'Flows', icon: Route },
              { to: '/bugs', label: 'Bugs', icon: Bug },
              { to: '/runs', label: 'Runs', icon: History },
              { to: '/breaker', label: 'Breaker', icon: Swords },
              { to: '/capture', label: 'Capture', icon: ClipboardPaste },
              { to: '/report', label: 'Report', icon: FileText },
              { to: '/settings', label: 'Settings', icon: Settings },
            ].map((i) => (
              <CommandItem key={i.to} onSelect={() => go(i.to)}>
                <i.icon />
                {i.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => act('guard', 'Guard is replaying every active flow')}>
              <ShieldCheck />
              Run Guard on all active flows
            </CommandItem>
            <CommandItem onSelect={() => act('break', 'Breaker hunt started')}>
              <Swords />
              Start a Breaker hunt
            </CommandItem>
            <CommandItem onSelect={() => go('/capture')}>
              <ClipboardPaste />
              Capture a bug report
            </CommandItem>
          </CommandGroup>
          {bugs && bugs.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Bugs">
                {bugs.map((b) => (
                  <CommandItem key={b.id} value={`${b.id} ${b.title}`} onSelect={() => go(`/bugs/${b.id}`)}>
                    <StatusIcon status={b.status} />
                    <span className="text-muted-foreground font-mono text-xs">{b.id}</span>
                    <span className="truncate">{b.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {flows && flows.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Flows">
                {flows.map((f) => (
                  <CommandItem key={f.id} value={`${f.id} ${f.title}`} onSelect={() => go(`/flows/${f.id}`)}>
                    <StatusIcon status={f.last ?? f.status} />
                    <span className="truncate">{f.title}</span>
                    <span className="text-muted-foreground ml-auto text-xs capitalize">{f.type}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </CommandDialog>
    </>
  )
}
