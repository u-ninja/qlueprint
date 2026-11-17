import * as React from 'react';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { selectTriggerClass } from '@/components/ui/select';
import { cn } from 'cn';

export type SearchSelectOption = { value: string; label: string; hint?: string };

type Props = {
    value: string;
    onValueChange: (value: string) => void;
    options: SearchSelectOption[];
    /** Shown when nothing is picked, or when the picked value is not in `options` */
    placeholder?: string;
    /** Small heading above the list */
    heading?: string;
    leading?: React.ReactNode;
    disabled?: boolean;
    title?: string;
    'aria-label'?: string;
    className?: string;
    contentClassName?: string;
};

/** A Select with a filter box: for lists too long to scan (every database on a server) */
export function SearchSelect({
    value,
    onValueChange,
    options,
    placeholder,
    heading,
    leading,
    disabled,
    className,
    contentClassName,
    ...rest
}: Props) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [active, setActive] = React.useState(0);
    const listRef = React.useRef<HTMLDivElement>(null);
    const id = React.useId();

    const shown = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    }, [options, query]);

    const onOpenChange = (next: boolean) => {
        setOpen(next);
        setQuery('');
        setActive(
            Math.max(
                0,
                options.findIndex((o) => o.value === value),
            ),
        );
    };
    const pick = (o: SearchSelectOption | undefined) => {
        if (!o) return;
        onValueChange(o.value);
        setOpen(false);
    };
    const move = (to: number) => {
        const i = Math.min(Math.max(to, 0), shown.length - 1);
        setActive(i);
        listRef.current?.children[i]?.scrollIntoView({ block: 'nearest' });
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') move(active + 1);
        else if (e.key === 'ArrowUp') move(active - 1);
        else if (e.key === 'Enter') pick(shown[active]);
        else return;
        e.preventDefault();
    };

    const current = options.find((o) => o.value === value);
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger disabled={disabled} data-slot="select-trigger" data-size="sm" className={cn(selectTriggerClass, className)} {...rest}>
                {leading}
                <span className={cn('min-w-0 flex-1 truncate text-left', !current && 'text-muted-foreground')}>{current?.label ?? placeholder}</span>
                <ChevronDownIcon className="size-4 text-muted-foreground transition-transform duration-300 group-data-[state=open]/select-trigger:rotate-180" />
            </PopoverTrigger>
            <PopoverContent align="end" className={cn('w-(--radix-popover-trigger-width) max-w-80 min-w-56 p-0', contentClassName)}>
                <div className="flex items-center gap-2 border-b border-border-soft px-2.5">
                    <SearchIcon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
                    <input
                        autoFocus
                        role="combobox"
                        aria-expanded
                        aria-controls={`${id}-list`}
                        aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
                        autoComplete="off"
                        spellCheck={false}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setActive(0);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder="Search…"
                        aria-label="Search"
                        className="h-9 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                    />
                </div>
                <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={heading} className="max-h-64 overflow-y-auto p-1">
                    {shown.map((o, i) => (
                        <div
                            key={o.value}
                            id={`${id}-${i}`}
                            role="option"
                            aria-selected={o.value === value}
                            title={o.label}
                            onClick={() => pick(o)}
                            onMouseMove={() => setActive(i)}
                            className={cn(
                                'flex h-8 cursor-default items-center gap-2 rounded-[5px] pr-2 pl-2.5 text-[13px] select-none',
                                i === active && 'bg-primary-soft',
                                o.value === value && 'font-medium',
                            )}
                        >
                            <span className="min-w-0 flex-1 truncate">{o.label}</span>
                            {o.hint && <span className="flex-none text-[11px] text-fg3">{o.hint}</span>}
                            {o.value === value && <CheckIcon className="size-4 flex-none text-primary-text" aria-hidden />}
                        </div>
                    ))}
                    {shown.length === 0 && <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">No matches</p>}
                </div>
            </PopoverContent>
        </Popover>
    );
}
