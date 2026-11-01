import { useEffect, useState } from "react";
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
    <main className="container">
      <h1>Profile</h1>
      {error && <p role="alert">{error}</p>}
      {!user && !error && <p>Loading...</p>}
      {user && (
        <>
          {image && <img src={image} alt="" width={96} height={96} style={{ borderRadius: "50%", margin: "0 auto" }} />}
          <dl>
            <dt>Name</dt>
            <dd>{user.name}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>User ID</dt>
            <dd>{user.id}</dd>
          </dl>
        </>
      )}
      <button onClick={() => auth.signOut()}>Sign out</button>
    </main>
  );
}
