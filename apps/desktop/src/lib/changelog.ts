import changelog from '../../CHANGELOG.md?raw';
import { version } from '@/lib/utils';

export type Change = {
    /** The lead phrase before a colon ("Table graph"), or empty when the line has none */
    title: string;
    detail: string;
    fixed: boolean;
};

type Release = { version: string; changes: Change[] };

/** "Title: detail" when a short lead phrase precedes the first colon; fixes start with "Fixed" */
function toChange(line: string): Change {
    const text = line.trim();
    const fixed = /^fix(ed|es)?\b/i.test(text);
    const colon = text.indexOf(': ');
    const lead = colon > 0 && colon <= 40 && !/[.,(]/.test(text.slice(0, colon)) ? colon : -1;
    return lead < 0 || fixed
        ? { title: '', detail: text, fixed }
        : { title: text.slice(0, lead), detail: text.slice(lead + 2), fixed };
}

/** The `- ` lines of a release's notes (a changelog section, or an update's release body) */
export const parseChanges = (notes: string): Change[] =>
    notes
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => toChange(l.slice(2)));

/** `## 0.1.9` headings, each followed by `- ` lines */
const releases: Release[] = changelog
    .split(/^## /m)
    .slice(1)
    .map((block) => {
        const [heading, ...lines] = block.split('\n');
        return { version: heading.trim(), changes: parseChanges(lines.join('\n')) };
    });

const parts = (v: string) => v.split('.').map(Number);
/** Negative when `a` is the older version */
function compareVersions(a: string, b: string) {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The releases since the one last shown, up to the running one, newest first */
export const releasesSince = (seen: string | null) =>
    releases.filter((r) => compareVersions(r.version, version) <= 0 && (!seen || compareVersions(r.version, seen) > 0)).slice(0, 3);
