import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { auth, signInWithGoogle } from '../lib/auth';

export function SignInPage() {
    const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get('email'));
        const password = String(form.get('password'));
        setError('');
        setPending(true);
        // On success useSession picks up the new session and App switches to the profile page
        const { error } =
            mode === 'signIn'
                ? await auth.signIn.email({ email, password })
                : await auth.signUp.email({ email, password, name: String(form.get('name')) });
        setPending(false);
        if (error) setError(error.message ?? 'Something went wrong');
    }

    return (
        <div className="flex flex-col gap-4">
            <form className="flex flex-col gap-3" onSubmit={onSubmit}>
                {mode === 'signUp' && (
                    <div className="grid gap-1.5">
                        <Label htmlFor="name">Name</Label>
                        <Input id="name" name="name" autoComplete="name" required />
                    </div>
                )}
                <div className="grid gap-1.5">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" name="email" type="email" autoComplete="email" required />
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="password">Password</Label>
                    <Input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                        minLength={8}
                        required
                    />
                </div>
                <Button type="submit" disabled={pending}>
                    {mode === 'signIn' ? 'Sign in' : 'Create account'}
                </Button>
            </form>
            <Button variant="link" className="h-auto p-0" onClick={() => setMode(mode === 'signIn' ? 'signUp' : 'signIn')}>
                {mode === 'signIn' ? 'No account? Create one' : 'Have an account? Sign in'}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator className="flex-1" />
                or
                <Separator className="flex-1" />
            </div>
            <Button variant="outline" onClick={() => signInWithGoogle(setError).catch((err) => setError(String(err)))}>
                Continue with Google
            </Button>
            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
