import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { auth } from '@/lib/auth';
import { ProfilePage } from '@/pages/ProfilePage';
import { SignInPage } from '@/pages/SignInPage';

// Sign-in is optional (product-spec §2.5): it lives behind this button and never blocks the workspace
export function AccountButton() {
    const session = auth.useSession();
    const user = session.data?.user;

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="ghost" size="sm" disabled={session.isPending}>
                    {user ? user.name : 'Sign in'}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{user ? 'Account' : 'Sign in to QueryCraft'}</DialogTitle>
                    <DialogDescription>
                        {user
                            ? 'Your account is only used for collaboration features.'
                            : 'Optional. Only needed for collaboration; everything else works without an account.'}
                    </DialogDescription>
                </DialogHeader>
                {user ? <ProfilePage image={user.image} /> : <SignInPage />}
            </DialogContent>
        </Dialog>
    );
}
