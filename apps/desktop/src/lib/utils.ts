import { isTauri as inTauri } from '@tauri-apps/api/core';

export { cn } from 'cn';
/** The release this build is, as the updater compares it */
export { version } from '../../package.json';

export const isMac = navigator.userAgent.includes('Mac');

/** False in a plain browser tab (`pnpm dev`), where window and event APIs don't exist */
export const isTauri = inTauri();

/** "Ctrl+S" as this platform writes it: "⌘ S" on macOS, "Ctrl + S" elsewhere */
export const shortcutLabel = (keys: string) =>
    keys
        .split('+')
        .map((k) => (isMac && k === 'Ctrl' ? '⌘' : k))
        .join(isMac ? ' ' : ' + ');

export const runShortcut = shortcutLabel('Ctrl+Enter');
export const explainShortcut = shortcutLabel('Ctrl+E');
export const explainAnalyzeShortcut = shortcutLabel('Ctrl+Shift+E');
export const newQueryShortcut = shortcutLabel('Ctrl+T');
export const saveShortcut = shortcutLabel('Ctrl+S');

/** "1 row", "2,500 rows"; pass `plural` when adding "s" is wrong ("entries") */
export const count = (n: number, word: string, plural = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : plural}`;

const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB'];
/** "512 B", "1.2 MB": binary units. Not Intl's compact notation, which reads "1.8L" in en-IN */
export function formatBytes(n: number) {
    const i = Math.min(byteUnits.length - 1, Math.floor(Math.log(Math.max(n, 1)) / Math.log(1024)));
    return `${oneDecimal.format(n / 1024 ** i)} ${byteUnits[i]}`;
}
