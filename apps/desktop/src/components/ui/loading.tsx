import { cn } from 'cn';

// Twelve spokes, each fainter than the one ahead, turned a spoke at a time: macOS's activity indicator
const spokes = Array.from({ length: 12 }, (_, i) => i);

/** The small native-style spinner for work in progress; in the text colour, still under reduced motion */
export function Spinner({ className, label }: { className?: string; label?: string }) {
    return (
        <svg
            viewBox="0 0 16 16"
            role={label ? 'img' : undefined}
            aria-label={label}
            aria-hidden={!label || undefined}
            className={cn('size-3.5 flex-none animate-[spin_0.9s_steps(12)_infinite] motion-reduce:animate-none', className)}
        >
            {spokes.map((i) => (
                <line
                    key={i}
                    x1="8"
                    y1="1.75"
                    x2="8"
                    y2="4.75"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity={(i + 1) / 12}
                    transform={`rotate(${i * 30} 8 8)`}
                />
            ))}
        </svg>
    );
}

/** A placeholder bar the shape of the text that's on its way */
export function Skeleton({ className }: { className?: string }) {
    return <span aria-hidden className={cn('block h-2.5 animate-pulse rounded-sm bg-fg4/15 motion-reduce:animate-none', className)} />;
}
