import { cn } from 'cn';

/** The spinner for work in progress: a thin ring with a slightly thicker arc, a fifth of the circle, running round it. In the text colour, still under reduced motion */
export function Spinner({ className, label }: { className?: string; label?: string }) {
    return (
        <svg
            viewBox="0 0 16 16"
            fill="none"
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={!label || undefined}
            className={cn('size-3.5 flex-none animate-[spin_0.8s_linear_infinite] motion-reduce:animate-none', className)}
        >
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" opacity="0.22" />
            <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray="20 80" />
        </svg>
    );
}

/** A placeholder bar the shape of the text that's on its way */
export function Skeleton({ className }: { className?: string }) {
    return <span aria-hidden className={cn('block h-2.5 animate-pulse rounded-sm bg-fg4/15 motion-reduce:animate-none', className)} />;
}
