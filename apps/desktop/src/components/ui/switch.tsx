import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

// shadcn's Switch, with named transitions instead of transition-all
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={cn(
                'group/switch peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-transparent shadow-[inset_0_1px_2px_oklch(0_0_0/0.3)] transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80',
                className,
            )}
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-[0_1px_2px_oklch(0_0_0/0.4),inset_0_1px_0_oklch(1_0_0/0.5)] ring-0 transition-[translate,width] duration-300 group-active/switch:w-5 data-[state=checked]:translate-x-3.5 data-[state=checked]:group-active/switch:translate-x-2.5 data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
            />
        </SwitchPrimitive.Root>
    );
}

export { Switch };
