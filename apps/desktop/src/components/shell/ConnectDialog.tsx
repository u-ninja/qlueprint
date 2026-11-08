import { useState, type ComponentProps, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { commands, type ConnectRequest } from "@/bindings";
import { errorMessage, useConnections } from "@/stores/connections";
import { engineName } from "@/lib/engines";
import { cn } from "@/lib/utils";

type Kind = ConnectRequest["kind"];

const kinds = Object.keys(engineName) as Kind[];

type ServerKind = Exclude<Kind, "sqlite">;

/** Starting values for the server fields, per database type */
const serverDefaults: Record<ServerKind, { port: number; user: string; database: string }> = {
  postgres: { port: 5432, user: "postgres", database: "Same as user" },
  mysql: { port: 3306, user: "root", database: "None" },
};

function requestFrom(form: HTMLFormElement, kind: Kind): ConnectRequest {
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "");
  return kind === "sqlite"
    ? { kind, path: text("path") }
    : {
        kind,
        host: text("host"),
        port: Number(text("port")),
        user: text("user"),
        password: text("password"),
        database: text("database"),
        // A Radix Switch with a name submits "on" through a hidden checkbox when checked
        showAllDatabases: data.get("showAllDatabases") === "on",
      };
}

function Field({ label, name, ...props }: { label: string; name: string } & ComponentProps<typeof Input>) {
  const id = `connect-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} {...props} />
    </div>
  );
}

/** Free text until "Browse" loads the server's databases with the fields above, then a list to pick from */
function DatabaseField({ kind }: { kind: ServerKind }) {
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const placeholder = serverDefaults[kind].database;

  async function browse(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    setError("");
    setLoading(true);
    try {
      const found = await commands.listDatabases(requestFrom(form, kind));
      if (found.length) setDatabases(found);
      else setError("No databases found on this server.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="connect-database">Database</Label>
      <div className="flex gap-2">
        {databases ? (
          <Select name="database">
            <SelectTrigger id="connect-database" className="min-w-0 flex-1">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent position="popper">
              {databases.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input id="connect-database" name="database" placeholder={placeholder} className="min-w-0 flex-1" />
        )}
        <Button type="button" variant="outline" onClick={browse} disabled={loading}>
          {loading ? "Loading…" : "Browse"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Wraps any trigger (children) so every "Connect" entry point opens the same dialog. */
export function ConnectDialog({ children }: { children: ReactNode }) {
  const connect = useConnections((s) => s.connect);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("postgres");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = requestFrom(event.currentTarget, kind);

    setError("");
    setPending(true);
    try {
      await connect(request);
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect to a database</DialogTitle>
          <DialogDescription>Saved on this device. The password goes into your system’s credential store.</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Database type" className="flex rounded-lg p-0.5 ring-1 ring-border">
          {kinds.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={cn(
                "flex-1 rounded-md py-1 text-fg3 transition-colors hover:text-foreground",
                kind === value && "bg-muted text-foreground",
              )}
            >
              {engineName[value]}
            </button>
          ))}
        </div>

        {/* key resets the fields when the type changes */}
        <form key={kind} className="flex flex-col gap-3" onSubmit={onSubmit}>
          {kind !== "sqlite" ? (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label="Host" name="host" defaultValue="localhost" required />
                <Field label="Port" name="port" type="number" min={1} max={65535} defaultValue={serverDefaults[kind].port} required />
              </div>
              <Field label="User" name="user" defaultValue={serverDefaults[kind].user} autoComplete="username" required />
              <Field label="Password" name="password" type="password" autoComplete="current-password" />
              <DatabaseField kind={kind} />
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="connect-show-all" className="flex flex-col items-start gap-0.5 font-normal">
                  Show all databases
                  <span className="text-xs text-fg3">List every database on the server, not just this one</span>
                </Label>
                <Switch id="connect-show-all" name="showAllDatabases" />
              </div>
            </>
          ) : (
            // shortcut: typed path, add a native file picker (tauri-plugin-dialog) when the wizard UI lands
            <Field label="Database file" name="path" placeholder="/path/to/database.db" required />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </Button>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
