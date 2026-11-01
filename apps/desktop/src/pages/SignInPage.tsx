import { useState, type FormEvent } from "react";
import { auth, signInWithGoogle } from "../lib/auth";

export function SignInPage() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setError("");
    setPending(true);
    // On success useSession picks up the new session and App switches to the profile page
    const { error } =
      mode === "signIn"
        ? await auth.signIn.email({ email, password })
        : await auth.signUp.email({ email, password, name: String(form.get("name")) });
    setPending(false);
    if (error) setError(error.message ?? "Something went wrong");
  }

  return (
    <main className="container">
      <h1>QueryCraft</h1>
      <form className="auth-form" onSubmit={onSubmit}>
        {mode === "signUp" && (
          <label>
            Name
            <input name="name" autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          {mode === "signIn" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button type="button" className="link-button" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
        {mode === "signIn" ? "No account? Create one" : "Have an account? Sign in"}
      </button>
      <p>or</p>
      <button onClick={() => signInWithGoogle(setError).catch((err) => setError(String(err)))}>
        Continue with Google
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
