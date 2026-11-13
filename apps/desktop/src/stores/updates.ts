import { create } from 'zustand';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { errorMessage } from './connections';
import { version } from '@/lib/utils';

type Updates = {
    /** A newer release, once a check found one */
    update: Update | null;
    /** The "Install QluePrint x.y.z?" dialog */
    installOpen: boolean;
    /** What a check from the menu or Settings found when there's nothing to install: up to date, or why it failed */
    notice: { title: string; text: string } | null;
    checking: boolean;
    /** null: not started; a number: percent downloaded; a string: why installing failed */
    progress: number | string | null;
};

export const useUpdates = create<Updates>(() => ({ update: null, installOpen: false, notice: null, checking: false, progress: null }));

/**
 * Asks GitHub for a newer release and opens the install dialog when there is one. At launch a
 * failed check (offline, GitHub down) stays quiet; `manual` (Check for updates…) also says when
 * there's nothing new or the check failed
 */
export async function checkForUpdates(manual = false) {
    const { checking, progress } = useUpdates.getState();
    if (checking || typeof progress === 'number') return;
    useUpdates.setState({ checking: true });
    try {
        const update = await check();
        if (update) useUpdates.setState({ update, installOpen: true });
        else if (manual) useUpdates.setState({ notice: { title: 'You’re up to date', text: `QluePrint ${version} is the latest release.` } });
    } catch (error) {
        if (manual)
            useUpdates.setState({
                notice: { title: 'Couldn’t check for updates', text: `${errorMessage(error)}. Check your internet connection and try again.` },
            });
    } finally {
        useUpdates.setState({ checking: false });
    }
}

/** Downloads and installs the found update, then restarts the app */
export async function installUpdate() {
    const { update } = useUpdates.getState();
    if (!update) return;
    const set = (progress: Updates['progress']) => useUpdates.setState({ progress });
    set(0);
    let total = 0;
    let done = 0;
    try {
        await update.downloadAndInstall((e) => {
            if (e.event === 'Started') total = e.data.contentLength ?? 0;
            else if (e.event === 'Progress' && total) {
                done += e.data.chunkLength;
                // Whole percents only: a download arrives in thousands of chunks
                const percent = Math.round((done / total) * 100);
                if (percent !== useUpdates.getState().progress) set(percent);
            }
        });
        await relaunch();
    } catch (error) {
        set(errorMessage(error));
    }
}
