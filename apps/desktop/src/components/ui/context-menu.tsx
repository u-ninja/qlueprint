import * as React from 'react';
import { cn } from 'cn';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { ChevronRightIcon } from 'lucide-react';

// Same surface and item styles as menubar.tsx, so right-click menus match the app menu

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
    return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
    return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.Content
                data-slot="context-menu-content"
                className={cn(
                    'z-50 min-w-36 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg surface-float p-1 text-popover-foreground duration-200 ease-spring data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
                    className,
                )}
                {...props}
            />
        </ContextMenuPrimitive.Portal>
    );
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
    return (
        <ContextMenuPrimitive.Item
            data-slot="context-menu-item"
            className={cn(
                "relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-primary-soft focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            {...props}
        />
    );
}

/** A destructive item (Remove, Delete): danger-colored, like menubar's `variant="destructive"`. Goes last in its menu */
function ContextMenuDestructiveItem({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item>) {
    return (
        <ContextMenuItem
            data-variant="destructive"
            className={cn(
                'text-destructive focus:bg-destructive/10 focus:text-destructive dark:focus:bg-destructive/20 *:[svg]:text-destructive!',
                className,
            )}
            {...props}
        />
    );
}

/** A small heading over a group of items */
function ContextMenuLabel({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
    return (
        <ContextMenuPrimitive.Label
            data-slot="context-menu-label"
            className={cn('px-1.5 py-1 text-[11px] font-medium text-fg4', className)}
            {...props}
        />
    );
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
    return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
    return (
        <span
            data-slot="context-menu-shortcut"
            className={cn('ml-auto flex-none pl-6 text-xs whitespace-nowrap text-muted-foreground', className)}
            {...props}
        />
    );
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
    return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
    return (
        <ContextMenuPrimitive.SubTrigger
            data-slot="context-menu-sub-trigger"
            className={cn(
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none focus:bg-primary-soft focus:text-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            {...props}
        >
            {children}
            <ChevronRightIcon className="ml-auto size-4" />
        </ContextMenuPrimitive.SubTrigger>
    );
}

function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.SubContent
                data-slot="context-menu-sub-content"
                className={cn(
                    'z-50 min-w-32 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-200 ease-spring data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
                    className,
                )}
                {...props}
            />
        </ContextMenuPrimitive.Portal>
    );
}

export {
    ContextMenu,
    ContextMenuSub,
    ContextMenuSubTrigger,
    ContextMenuSubContent,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuDestructiveItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuShortcut,
};
