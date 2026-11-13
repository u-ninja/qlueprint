import { useEffect, useId, useState, type ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import { appDataDir, join } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingRow, SwitchRow } from '@/components/ui/setting-row';
import { hasKeys, menus, motions, themes } from '@/components/shell/menu';
import { checkForUpdates, useUpdates } from '@/stores/updates';
import { useUi } from '@/stores/ui';
import { motion as motionSetting } from '@/lib/spring';
import { isTauri, shortcutLabel, version } from '@/lib/utils';

/** In page order; the sidebar lists them and Help › Keyboard shortcuts opens `shortcuts` */
export const settingsSections = [
    { id: 'appearance', title: 'Appearance' },
    { id: 'updates', title: 'Updates' },
    { id: 'shortcuts', title: 'Keyboard shortcuts' },
    { id: 'data', title: 'Data & privacy' },
] as const;
type SectionId = (typeof settingsSections)[number]['id'];
const anchor = (id: string) => `settings-${id}`;

// Every menu item with a shortcut, under its menu's name
const shortcuts = menus.map(({ label, entries }) => ({ label, items: entries.filter(hasKeys) })).filter((m) => m.items.length);

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
    const heading = useId();
    return (
        <section id={anchor(id)} aria-labelledby={heading} className="scroll-mt-4 border-b border-border-soft py-6 last:border-b-0">
            <h2 id={heading} className="mb-4 text-[13px] font-medium">
                {settingsSections.find((s) => s.id === id)?.title}
            </h2>
            <div className="flex flex-col gap-4">{children}</div>
        </section>
    );
}

function SelectRow<T extends string>({
    id,
    label,
    description,
    value,
    options,
    onChange,
}: {
    id: string;
    label: string;
    description: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
}) {
    return (
        <SettingRow label={label} description={description} htmlFor={id}>
            <Select value={value} onValueChange={(v) => onChange(v as T)}>
                <SelectTrigger id={id} size="sm" className="w-40 flex-none">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                    {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </SettingRow>
    );
}

/** A file the app keeps, with a button that shows it in Finder / Explorer */
function PathRow({ label, description, path }: { label: string; description: string; path: string | null }) {
    return (
        <SettingRow
            label={label}
            description={
                <>
                    {description}
                    <code className="mt-0.5 block truncate font-mono text-[11px] text-fg4" title={path ?? undefined}>
                        {path ?? '…'}
                    </code>
                </>
            }
        >
            <Button variant="outline" size="sm" disabled={!path} onClick={() => path && void revealItemInDir(path)} className="flex-none">
                <FolderOpen aria-hidden />
                Show
            </Button>
        </SettingRow>
    );
}

export function SettingsPage() {
    const theme = useUi((s) => s.theme);
    const motion = useUi((s) => s.motion);
    const checkUpdates = useUi((s) => s.checkUpdates);
    const section = useUi((s) => s.settingsSection);
    const checking = useUpdates((s) => s.checking);

    // A section asked for from the sidebar or the Help menu: scrolled to once it has rendered, then cleared
    useEffect(() => {
        if (!section) return;
        document.getElementById(anchor(section))?.scrollIntoView({ block: 'start', behavior: motionSetting() === 'off' ? 'auto' : 'smooth' });
        useUi.setState({ settingsSection: null });
    }, [section]);

    // shortcut: the file names copy saved::FILE and audit::FILE in src-tauri; return them from a command if either moves
    const [paths, setPaths] = useState<{ connections: string; audit: string } | null>(null);
    useEffect(() => {
        if (!isTauri) return;
        void appDataDir()
            .then((dir) => Promise.all([join(dir, 'connections.json'), join(dir, 'audit.db')]))
            .then(([connections, audit]) => setPaths({ connections, audit }));
    }, []);

    const { setTheme, setMotion, setCheckUpdates } = useUi.getState();
    return (
        <main aria-label="Settings" className="h-full min-w-0 overflow-y-auto bg-editor">
            <div className="max-w-3xl px-8 pt-2 pb-8">
                <Section id="appearance">
                    <SelectRow
                        id="settings-theme"
                        label="Theme"
                        description="Match system follows your OS light or dark mode."
                        value={theme}
                        options={themes}
                        onChange={setTheme}
                    />
                    <SelectRow
                        id="settings-motion"
                        label="Motion"
                        description="How panels, tabs and menus move. Reduced turns animation off."
                        value={motion}
                        options={motions}
                        onChange={setMotion}
                    />
                </Section>

                <Section id="updates">
                    <SettingRow
                        label={
                            <span>
                                QluePrint <span className="font-mono tabular-nums">{version}</span>
                            </span>
                        }
                        description="New releases come from GitHub and are checked against the app’s signing key."
                    >
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!isTauri || checking}
                            onClick={() => void checkForUpdates(true)}
                            className="flex-none"
                        >
                            {checking ? 'Checking…' : 'Check now'}
                        </Button>
                    </SettingRow>
                    <SwitchRow
                        id="settings-check-updates"
                        label="Check for updates on launch"
                        description="When a new release is out, QluePrint asks whether to install it."
                        checked={checkUpdates}
                        onCheckedChange={setCheckUpdates}
                    />
                </Section>

                <Section id="shortcuts">
                    <div className="grid gap-x-10 gap-y-6 lg:grid-cols-2">
                        {shortcuts.map((menu) => (
                            <div key={menu.label}>
                                <h3 className="mb-1 text-xs text-fg3">{menu.label}</h3>
                                <dl className="divide-y divide-border-soft">
                                    {menu.items.map((item) => (
                                        <div key={item.id} className="flex items-center justify-between gap-3 py-1.5">
                                            <dt className="truncate">{item.label.replace(/…$/, '')}</dt>
                                            <dd className="flex-none">
                                                <Kbd>{shortcutLabel(item.keys)}</Kbd>
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </div>
                        ))}
                    </div>
                </Section>

                <Section id="data">
                    <p className="text-fg3">
                        Everything stays on this computer, and QluePrint sends no telemetry. Passwords and sign-ins are kept in your system’s
                        credential store, not in these files.
                    </p>
                    <PathRow
                        label="Saved connections"
                        description="Hosts, users and options for each connection."
                        path={paths?.connections ?? null}
                    />
                    <PathRow
                        label="Audit log"
                        description="Every connection and statement the app ran, chained by hash."
                        path={paths?.audit ?? null}
                    />
                </Section>
            </div>
        </main>
    );
}
