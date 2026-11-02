import { Database, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useUi, type Theme } from "@/stores/ui";
import { auth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { AccountButton } from "./AccountButton";

const themes: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
  { value: "system", label: "Match system theme", icon: Monitor },
];

export function TopBar() {
  const { theme, setTheme } = useUi();
  const session = auth.useSession();

  return (
    <header className="flex h-11 flex-none items-center gap-3 border-b border-border-soft bg-chrome pr-2.5 pl-3.5">
      <div className="flex items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
          <Database className="size-3.5" aria-hidden />
        </span>
        QueryCraft
      </div>
      <span className="text-fg2">Local Workspace</span>
      {!session.data && (
        <span className="flex items-center gap-1.5 text-xs text-fg3">
          <span className="size-1.5 rounded-full bg-fg4" aria-hidden />
          Offline · No account required
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
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
    </header>
  );
}
