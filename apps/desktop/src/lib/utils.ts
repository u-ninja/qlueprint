export { cn } from "cn"

export const runShortcut = navigator.userAgent.includes("Mac") ? "⌘ Enter" : "Ctrl + Enter"

/** "1 row", "2,500 rows" */
export const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`
