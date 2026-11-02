import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch, auth } from "../lib/auth";

type User = { id: string; name: string; email: string };

export function ProfilePage({ image }: { image?: string | null }) {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/v1/users/me")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
        setUser(body);
      })
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!user && !error && <p className="text-muted-foreground">Loading...</p>}
      {user && (
        <div className="flex items-center gap-3">
          {image && <img src={image} alt="" className="size-12 rounded-full" />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{user.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{user.email}</dd>
            <dt className="text-muted-foreground">User ID</dt>
            <dd className="font-mono text-xs">{user.id}</dd>
          </dl>
        </div>
      )}
      <Button variant="outline" onClick={() => auth.signOut()}>
        Sign out
      </Button>
    </div>
  );
}
