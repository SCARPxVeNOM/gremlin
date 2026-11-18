import { cn } from '@/lib/utils'

/** The Gremlin mark: a small horned square with mischievous eyes. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6', className)} aria-hidden>
      <path d="M7 9 5 3l6 4M25 9l2-6-6 4" fill="currentColor" />
      <rect x="4" y="7" width="24" height="22" rx="7" fill="currentColor" />
      <path d="M10 16.5c1.2-1.4 3-1.4 4.2 0M17.8 16.5c1.2-1.4 3-1.4 4.2 0" stroke="var(--background)" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M11.5 22.5c2.8 1.6 6.2 1.6 9 0" stroke="var(--background)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  )
}
