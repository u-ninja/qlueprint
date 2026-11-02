import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = ComponentProps<typeof Button> & { wrapperClassName?: string };

// shortcut: placeholder for actions whose feature is not built yet, replace each use with the real action when its roadmap step lands
export function PendingAction({ wrapperClassName, ...props }: Props) {
  return (
    // Disabled buttons ignore hover, so the explanation sits on a wrapper
    <span title="Not built yet" className={cn("inline-flex", wrapperClassName)}>
      <Button {...props} disabled aria-description="Not built yet" />
    </span>
  );
}
