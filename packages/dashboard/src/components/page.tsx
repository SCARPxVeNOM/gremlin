import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        {description && <p className="text-muted-foreground max-w-2xl text-sm md:text-base">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8', className)}>{children}</div>
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      {icon && <div className="text-muted-foreground mb-1 [&>svg]:size-6">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="text-muted-foreground max-w-md text-sm">{children}</div>}
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="bg-muted relative rounded px-[0.35rem] py-[0.15rem] font-mono text-[0.85em]">{children}</code>
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground pointer-events-none inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium select-none">
      {children}
    </kbd>
  )
}
