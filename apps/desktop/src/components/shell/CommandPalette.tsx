import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useConnections } from '@/stores/connections';
import { useQuery } from '@/stores/query';
import { inShownWorkspace, useUi } from '@/stores/ui';
import { cn, isMac, shortcutLabel } from '@/lib/utils';
import { menus, type Actions } from './menu';

type Command = { group: string; label: string; keys?: string; run: () => void };

/** Results shown at once, as in the prototype */
const LIMIT = 12;

/**
 * The commands on offer: every menu action that's built (grouped by its menu), then each open
 * connection's tables to open, and the shown workspace's connections to use or connect.
 */
function useCommands(actions: Actions): Command[] {
    const connections = useConnections((s) => s.connections);
    const saved = useConnections((s) => s.saved);
    const open = useUi((s) => s.paletteOpen);
    return useMemo(() => {
        if (!open) return [];
        const out: Command[] = [];
        for (const menu of menus)
            for (const entry of menu.entries) {
                if (entry === 'separator') continue;
                // Theme and Motion: one command per choice, named after its submenu
                const items = 'items' in entry ? entry.items.map((i) => ({ ...i, label: `${entry.label}: ${i.label}` })) : [entry];
                for (const item of items) {
                    const run = actions[item.id];
                    if (!run || item.id === 'command-palette' || ('typing' in item && item.typing)) continue;
                    out.push({ group: menu.label, label: item.label, keys: 'keys' in item ? item.keys : undefined, run });
                }
            }
        const { openTable, setConnectionId } = useQuery.getState();
        for (const c of connections) {
            if (!inShownWorkspace(c.savedId)) continue;
            out.push({ group: 'Connect', label: `Use ${c.label}`, run: () => setConnectionId(c.id) });
            for (const s of c.schemas)
                for (const t of s.tables)
                    out.push({
                        group: 'Table',
                        label: `Open ${s.name}.${t.name}`,
                        // MySQL's schemas are its databases
                        run: () => void openTable(c.id, c.kind === 'mysql' ? s.name : c.database, s.name, t.name),
                    });
        }
        const openIds = new Set(connections.map((c) => c.savedId));
        for (const entry of saved)
            if (!openIds.has(entry.id) && inShownWorkspace(entry.id))
                out.push({ group: 'Connect', label: `Connect ${entry.label}`, run: () => void useConnections.getState().open(entry.id) });
        return out;
    }, [actions, connections, saved, open]);
}

/** Substring matches first (earlier is better), then letters in order; 0 for no match */
function score(text: string, query: string) {
    const s = text.toLowerCase();
    const at = s.indexOf(query);
    if (at >= 0) return 2 - at / 100;
    let i = 0;
    for (const ch of s) if (ch === query[i]) i++;
    return i === query.length ? 1 : 0;
}

/** ⌘K or ⌘⇧P: run any command, open a table or switch connection by typing a few letters */
export function CommandPalette({ actions }: { actions: Actions }) {
    const open = useUi((s) => s.paletteOpen);
    const setOpen = useUi((s) => s.setPaletteOpen);
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const commands = useCommands(actions);

    const q = query.trim().toLowerCase();
    const shown = useMemo(
        () =>
            q
                ? commands
                      .map((c) => [c, score(`${c.group} ${c.label}`, q)] as const)
                      .filter(([, s]) => s > 0)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, LIMIT)
                      .map(([c]) => c)
                : commands.slice(0, LIMIT),
        [commands, q],
    );
    const current = Math.min(index, Math.max(0, shown.length - 1));

    // ⌘K, as in the mockup; ⌘⇧P comes from the View menu. Captured first so the editor's own
    // ⌘K chords don't swallow it
    useEffect(() => {
        function onKeyDown(e: globalThis.KeyboardEvent) {
            if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                e.stopPropagation();
                useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen);
            }
        }
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, []);

    const close = (o: boolean) => {
        setOpen(o);
        if (!o) {
            setQuery('');
            setIndex(0);
        }
    };
    const run = (c: Command | undefined) => {
        if (!c) return;
        close(false);
        c.run();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setIndex((current + step + shown.length) % Math.max(1, shown.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            run(shown[current]);
        }
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent
                showCloseButton={false}
                className="top-[14vh] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]"
                aria-describedby={undefined}
            >
                <DialogTitle className="sr-only">Command palette</DialogTitle>
                <div className="flex h-12 items-center gap-2.5 border-b border-border-soft px-3.5">
                    <Search className="size-4 flex-none text-fg3" aria-hidden />
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setIndex(0);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder="Type a command or search tables…"
                        aria-label="Command or table"
                        aria-controls="palette-results"
                        aria-activedescendant={shown[current] ? `palette-${current}` : undefined}
                        role="combobox"
                        aria-expanded
                        autoComplete="off"
                        spellCheck={false}
                        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-fg4"
                    />
                    <Kbd className="flex-none">esc</Kbd>
                </div>
                <ul id="palette-results" role="listbox" aria-label="Commands" className="max-h-[360px] overflow-auto p-1.5">
                    {shown.map((c, i) => (
                        <li
                            key={`${c.group}${c.label}`}
                            id={`palette-${i}`}
                            role="option"
                            aria-selected={i === current}
                            onMouseEnter={() => setIndex(i)}
                            onClick={() => run(c)}
                            className={cn(
                                'flex h-[34px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                                i === current && 'bg-muted',
                            )}
                        >
                            <span className="w-[58px] flex-none text-[11px] text-fg3">{c.group}</span>
                            <span className="min-w-0 flex-1 truncate text-foreground">{c.label}</span>
                            {c.keys && <span className="flex-none font-mono text-[11px] text-fg3">{shortcutLabel(c.keys)}</span>}
                        </li>
                    ))}
                    {!shown.length && <li className="p-6 text-center text-[13px] text-fg3">No matches</li>}
                </ul>
            </DialogContent>
        </Dialog>
    );
}
