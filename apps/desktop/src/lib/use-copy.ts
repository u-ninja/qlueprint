import { useEffect, useState } from 'react';

/** Copies text and reports it for a moment: `copied` is true for 1.2 s after a successful copy */
export function useCopy() {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1200);
        return () => clearTimeout(timer);
    }, [copied]);
    // A blocked clipboard leaves `copied` false, so nothing claims a copy that didn't happen
    const copy = (text: string | null | undefined) =>
        void navigator.clipboard.writeText(text ?? '').then(
            () => setCopied(true),
            () => {},
        );
    return [copied, copy] as const;
}
