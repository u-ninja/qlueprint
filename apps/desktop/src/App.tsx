import { auth } from "./lib/auth";
import { ProfilePage } from "./pages/ProfilePage";
import { SignInPage } from "./pages/SignInPage";
import "./App.css";

function App() {
  const session = auth.useSession();

  if (session.isPending) return <main className="container">Loading...</main>;

  if (session.data) return <ProfilePage image={session.data.user.image} />;

  return <SignInPage />;
}

export default App;
