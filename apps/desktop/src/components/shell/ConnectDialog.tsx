import { useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectRequest } from "@/bindings";
import { errorMessage, useConnections } from "@/stores/connections";
import { cn } from "@/lib/utils";

type Kind = ConnectRequest["kind"];

const kinds: { value: Kind; label: string }[] = [
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
];

function Field({ label, name, ...props }: { label: string; name: string } & ComponentProps<typeof Input>) {
  const id = `connect-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} {...props} />
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
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const request: ConnectRequest =
      kind === "postgres"
        ? {
            kind,
            host: text("host"),
            port: Number(text("port")),
            user: text("user"),
            password: text("password"),
            database: text("database"),
          }
        : { kind, path: text("path") };

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
          <DialogDescription>The connection stays on this device.</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label="Database type" className="flex rounded-md bg-muted p-0.5">
          {kinds.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={cn(
                "flex-1 rounded py-1 text-fg3 hover:text-foreground",
                kind === value && "bg-primary-soft text-primary-text hover:text-primary-text",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* key resets the fields when the type changes */}
        <form key={kind} className="flex flex-col gap-3" onSubmit={onSubmit}>
          {kind === "postgres" ? (
            <>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label="Host" name="host" defaultValue="localhost" required />
                <Field label="Port" name="port" type="number" min={1} max={65535} defaultValue={5432} required />
              </div>
              <Field label="User" name="user" defaultValue="postgres" autoComplete="username" required />
              <Field label="Password" name="password" type="password" autoComplete="current-password" />
              <Field label="Database" name="database" placeholder="Same as user" />
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
