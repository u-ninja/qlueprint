import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonClass =
    'grid h-full w-[46px] place-items-center text-fg2 transition-colors outline-none hover:bg-hover hover:text-foreground focus-visible:bg-hover focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/** Minimize, maximize/restore and close for Windows and Linux, where the window has no OS title bar */
export function WindowControls() {
    const [appWindow] = useState(getCurrentWindow);
    const [maximized, setMaximized] = useState(false);

    useEffect(() => {
        // Also catches maximizing by double-click, snapping and keyboard. Resizing fires many events
        // a second, so ask once it settles.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sync = () => void appWindow.isMaximized().then(setMaximized);
        sync();
        const unlisten = appWindow.onResized(() => {
            clearTimeout(timer);
            timer = setTimeout(sync, 100);
        });
        return () => {
            clearTimeout(timer);
            void unlisten.then((stop) => stop());
        };
    }, [appWindow]);

    const label = maximized ? 'Restore' : 'Maximize';

    return (
        <div className="flex h-full flex-none">
            <button aria-label="Minimize" title="Minimize" onClick={() => void appWindow.minimize()} className={buttonClass}>
                <Minus className="size-4" strokeWidth={1.5} aria-hidden />
            </button>
            <button aria-label={label} title={label} onClick={() => void appWindow.toggleMaximize()} className={buttonClass}>
                {maximized ? (
                    <Copy className="size-3.5 -scale-x-100" strokeWidth={1.5} aria-hidden />
                ) : (
                    <Square className="size-3.5" strokeWidth={1.5} aria-hidden />
                )}
            </button>
            <button
                aria-label="Close"
                title="Close"
                onClick={() => void appWindow.close()}
                className={cn(buttonClass, 'hover:bg-danger hover:text-primary-foreground')}
            >
                <X className="size-4" strokeWidth={1.5} aria-hidden />
            </button>
        </div>
    );
}
