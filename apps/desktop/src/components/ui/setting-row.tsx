import type { ComponentProps, ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** A setting: label and description on the left, its control on the right. `htmlFor` makes the label click the control */
export function SettingRow({
    label,
    description,
    htmlFor,
    children,
}: {
    label: ReactNode;
    description: ReactNode;
    htmlFor?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <Label htmlFor={htmlFor} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
                {label}
                <span className="text-xs text-fg3">{description}</span>
            </Label>
            {children}
        </div>
    );
}

/** A setting turned on or off */
export function SwitchRow({
    id,
    label,
    description,
    ...props
}: { id: string; label: string; description: ReactNode } & Pick<ComponentProps<typeof Switch>, 'checked' | 'onCheckedChange' | 'disabled'>) {
    return (
        <SettingRow label={label} description={description} htmlFor={id}>
            <Switch id={id} {...props} />
        </SettingRow>
    );
}
