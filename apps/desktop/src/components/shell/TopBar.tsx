import { useMemo, useRef } from "react";
import { Database, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useUi, type Theme } from "@/stores/ui";
import { auth } from "@/lib/auth";
import { cn, isMac, isTauri } from "@/lib/utils";
import { AccountButton } from "./AccountButton";
import { AppMenu } from "./AppMenu";
import { ConnectDialog } from "./ConnectDialog";
import { createActions, useNativeMenu } from "./menu";
import { WindowControls } from "./WindowControls";

const themes: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
  { value: "system", label: "Match system theme", icon: Monitor },
];

// Windows and Linux: the window has no OS title bar, so this draws the menu and window buttons.
// macOS: the native menu sits in the screen's menu bar and the traffic lights overlay the left edge.
const ownControls = isTauri && !isMac;

export function TopBar() {
  const { theme, setTheme } = useUi();
  const session = auth.useSession();
  const connectTrigger = useRef<HTMLButtonElement>(null);
  const actions = useMemo(() => createActions(() => connectTrigger.current?.click()), []);
  useNativeMenu(actions);

  return (
    // "deep": empty space and plain text anywhere in the bar drag the window; controls don't
    <header
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-11 flex-none items-center gap-3 border-b border-border-soft bg-chrome pl-3.5 select-none",
        ownControls ? "pr-0" : "pr-2.5",
      )}
    >
      {/* Room for the traffic lights, placed by src-tauri/src/chrome.rs */}
      {isTauri && isMac && <div className="w-[58px] flex-none" aria-hidden />}
      <div className="flex flex-none items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Database className="size-3.5" aria-hidden />
        </span>
        QueryCraft
      </div>
      {!isMac && <AppMenu actions={actions} />}
      <div className="h-[18px] w-px flex-none bg-border-soft" aria-hidden />
      <span className="flex-none text-fg2">Local Workspace</span>
      {!session.data && (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg3">
          <span className="size-1.5 flex-none rounded-full bg-fg4" aria-hidden />
          <span className="truncate">Offline · No account required</span>
        </span>
      )}

      <div className={cn("ml-auto flex flex-none items-center gap-2", ownControls && "pr-1")}>
        <div role="radiogroup" aria-label="Theme" className="flex rounded-md bg-muted p-0.5">
          {themes.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              aria-label={label}
              title={label}
              onClick={() => setTheme(value)}
              className={cn(
                "grid size-6 place-items-center rounded text-fg3 hover:text-foreground",
                theme === value && "bg-primary-soft text-primary-text hover:text-primary-text",
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          ))}
        </div>
        <AccountButton />
      </div>
      {ownControls && <WindowControls />}
      {/* shortcut: File › New connection opens the dialog through this hidden trigger; give
          ConnectDialog open/onOpenChange props once the MySQL branch has landed */}
      <ConnectDialog>
        <button ref={connectTrigger} hidden tabIndex={-1} />
      </ConnectDialog>
    </header>
  );
}
