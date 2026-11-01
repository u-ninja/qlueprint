import { createAuthClient } from "@neondatabase/auth";
import { BetterAuthReactAdapter } from "@neondatabase/auth/react/adapters";
import { cancel, onUrl, start } from "@fabianlars/tauri-plugin-oauth";
import { openUrl } from "@tauri-apps/plugin-opener";

export const auth = createAuthClient(import.meta.env.VITE_NEON_AUTH_URL, {
  adapter: BetterAuthReactAdapter(),
});

// Query param Neon Auth appends to the OAuth callback; the SDK reads it from the page URL
const VERIFIER_PARAM = "neon_auth_session_verifier";

// Google blocks sign-in inside embedded webviews, so run OAuth in the system browser
// and catch its redirect on a temporary loopback server.
// onError covers failures reported after this returns, when the browser redirect comes back with ?error=
export async function signInWithGoogle(onError: (message: string) => void) {
  const port = await start({ response: "You can close this tab and return to QueryCraft." });
  let unlisten = () => {};
  const stop = () => {
    clearTimeout(timer);
    unlisten();
    void cancel(port);
  };
  // The session challenge cookie expires after 10 minutes, after which the verifier is useless
  const timer = setTimeout(stop, 600_000);

  unlisten = await onUrl((url) => {
    const params = new URL(url).searchParams;
    const verifier = params.get(VERIFIER_PARAM);
    const error = params.get("error");
    // Ignore unrelated hits like /favicon.ico
    if (!verifier && !error) return;
    stop();
    if (!verifier) return onError(`Google sign-in failed: ${error}`);
    // The SDK trades the verifier plus this webview's challenge cookie for the session on load
    window.location.href = `/?${VERIFIER_PARAM}=${encodeURIComponent(verifier)}`;
  });

  // Called from this webview so the challenge cookie lands here, not in the browser
  const { data, error } = await auth.signIn.social({
    provider: "google",
    callbackURL: `http://localhost:${port}/`,
    disableRedirect: true,
  });
  if (error || !data?.url) {
    stop();
    throw new Error(error?.message ?? "Could not start Google sign-in");
  }
  await openUrl(data.url);
}

export async function apiFetch(path: string, init?: RequestInit) {
  // Neon Auth swaps session.token for the signed JWT the API verifies
  const { data } = await auth.getSession();
  const token = data?.session.token;
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, ...(token && { Authorization: `Bearer ${token}` }) },
  });
}
