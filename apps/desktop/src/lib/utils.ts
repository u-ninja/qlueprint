export { cn } from "cn"

export const runShortcut = navigator.userAgent.includes("Mac") ? "⌘ Enter" : "Ctrl + Enter"

/** "1 row", "2,500 rows"; pass `plural` when adding "s" is wrong ("entries") */
export const count = (n: number, word: string, plural = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : plural}`
