import { isTauri as inTauri } from "@tauri-apps/api/core"

export { cn } from "cn"

export const isMac = navigator.userAgent.includes("Mac")

/** False in a plain browser tab (`pnpm dev`), where window and event APIs don't exist */
export const isTauri = inTauri()

export const runShortcut = isMac ? "⌘ Enter" : "Ctrl + Enter"

/** "1 row", "2,500 rows"; pass `plural` when adding "s" is wrong ("entries") */
export const count = (n: number, word: string, plural = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : plural}`
