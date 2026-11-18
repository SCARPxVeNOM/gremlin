import {
  CircleCheck,
  CircleX,
  CircleDashed,
  CircleAlert,
  Loader,
  Waves,
  Lock,
  ShieldAlert,
  Archive,
  FlaskConical,
  Wrench,
  Siren,
  CircleHelp,
  Ban,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info'

const toneClass: Record<Tone, string> = {
  good: 'text-good',
  warning: 'text-warning',
  serious: 'text-serious',
  critical: 'text-critical',
  neutral: 'text-muted-foreground',
  info: 'text-series-1',
}

const STATUS: Record<string, { label: string; icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  passed: { label: 'Passed', icon: CircleCheck, tone: 'good' },
  failed: { label: 'Failed', icon: CircleX, tone: 'critical' },
  flaky: { label: 'Flaky', icon: Waves, tone: 'warning' },
  error: { label: "Couldn't run", icon: CircleAlert, tone: 'serious' },
  running: { label: 'Running', icon: Loader, tone: 'info', spin: true },
  done: { label: 'Done', icon: CircleCheck, tone: 'neutral' },
  skipped: { label: 'Skipped', icon: CircleDashed, tone: 'neutral' },
  tampered: { label: 'Edited', icon: ShieldAlert, tone: 'critical' },
  // flows
  active: { label: 'Active', icon: Lock, tone: 'good' },
  confirmed: { label: 'Confirmed', icon: FlaskConical, tone: 'serious' },
  draft: { label: 'Draft', icon: CircleDashed, tone: 'neutral' },
  quarantined: { label: 'Quarantined', icon: Waves, tone: 'warning' },
  retired: { label: 'Retired', icon: Archive, tone: 'neutral' },
  // bugs
  candidate: { label: 'Candidate', icon: CircleHelp, tone: 'warning' },
  fixing: { label: 'Fixing', icon: Wrench, tone: 'info', spin: false },
  fixed: { label: 'Fixed', icon: CircleCheck, tone: 'good' },
  escalated: { label: 'Escalated', icon: Siren, tone: 'critical' },
  'cant-reproduce': { label: "Can't reproduce", icon: CircleDashed, tone: 'neutral' },
  rejected: { label: 'Rejected', icon: Ban, tone: 'neutral' },
  // fix attempts
  blocked: { label: 'Blocked', icon: ShieldAlert, tone: 'critical' },
  'agent-error': { label: 'Agent error', icon: CircleAlert, tone: 'serious' },
  pending: { label: 'Pending', icon: Loader, tone: 'info', spin: true },
}

export function StatusIcon({ status, className }: { status?: string; className?: string }) {
  const s = STATUS[status ?? ''] ?? { icon: CircleDashed, tone: 'neutral' as Tone }
  const Icon = s.icon
  return <Icon className={cn('size-4 shrink-0', toneClass[s.tone], 'spin' in s && s.spin && 'animate-spin', className)} aria-hidden />
}

export function StatusBadge({ status, className }: { status?: string; className?: string }) {
  if (!status) return <span className="text-muted-foreground text-xs">never run</span>
  const s = STATUS[status] ?? { label: status, icon: CircleDashed, tone: 'neutral' as Tone }
  return (
    <Badge variant="outline" className={cn('gap-1 font-normal', className)}>
      <StatusIcon status={status} className="size-3" />
      {s.label}
    </Badge>
  )
}

const SEV: Record<string, { tone: Tone; bars: number }> = {
  critical: { tone: 'critical', bars: 4 },
  high: { tone: 'serious', bars: 3 },
  medium: { tone: 'warning', bars: 2 },
  low: { tone: 'neutral', bars: 1 },
}

/** Severity: a 4-step signal meter plus the word, so it never relies on color alone. */
export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEV[severity] ?? SEV.low
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize">
      <span className="flex items-end gap-px" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn('w-[3px] rounded-[1px]', i <= s.bars ? cn('bg-current', toneClass[s.tone]) : 'bg-muted-foreground/25')}
            style={{ height: 4 + i * 2 }}
          />
        ))}
      </span>
      {severity}
    </span>
  )
}

export function TypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="secondary" className="font-normal capitalize">
      {type}
    </Badge>
  )
}

export function Confidence({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      <span className="bg-muted relative h-1.5 w-12 overflow-hidden rounded-full">
        <span className="bg-foreground/70 absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      {Math.round(value * 100)}%
    </span>
  )
}

export function Stability({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground text-xs">–</span>
  const tone: Tone = value >= 90 ? 'good' : value >= 70 ? 'warning' : 'critical'
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      <span className="bg-muted relative h-1.5 w-12 overflow-hidden rounded-full">
        <span className={cn('absolute inset-y-0 left-0 rounded-full bg-current', toneClass[tone])} style={{ width: `${value}%` }} />
      </span>
      {value}%
    </span>
  )
}
