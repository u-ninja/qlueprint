import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQuery } from "@/stores/query";
import { useUi, type Theme } from "@/stores/ui";
import { isMac, isTauri } from "@/lib/utils";
import { views } from "./Rail";

// The app menu, shared by the in-app menu bar (Windows, Linux) and the native macOS menu, which
// is built in src-tauri/src/chrome.rs with the same item ids. Both run the actions below.

export type MenuItem = {
  id: string;
  label: string;
  /** Shown in the in-app menu, which only Windows and Linux use, and bound app-wide */
  keys?: string;
  /** The browser or editor already handles the shortcut while typing; only clicks run it */
  typing?: true;
  /** Ticked when true */
  checked?: (state: MenuState) => boolean;
};
/** One-of-many choice, e.g. Theme */
export type Submenu = { label: string; items: MenuItem[]; selected: (state: MenuState) => string };
export type MenuEntry = MenuItem | Submenu | "separator";
export type Menu = { label: string; entries: MenuEntry[] };

/** The store fields the ticks show */
export type MenuState = Pick<ReturnType<typeof useUi.getState>, "sidebarOpen" | "inspectorOpen" | "theme">;

/** Item id → what it does. Items with no action are features that aren't built yet. */
export type Actions = Partial<Record<string, () => void>>;

const themes: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match system" },
];

export const menus: Menu[] = [
  {
    label: "File",
    entries: [
      { id: "new-connection", label: "New connection…" },
      { id: "open-file", label: "Open SQL file…", keys: "Ctrl+O" },
      "separator",
      { id: "save", label: "Save", keys: "Ctrl+S" },
      "separator",
      { id: "settings", label: "Settings…", keys: "Ctrl+," },
      "separator",
      { id: "exit", label: "Exit" },
    ],
  },
  {
    label: "Edit",
    entries: [
      { id: "undo", label: "Undo", keys: "Ctrl+Z", typing: true },
      { id: "redo", label: "Redo", keys: "Ctrl+Y", typing: true },
      "separator",
      { id: "cut", label: "Cut", keys: "Ctrl+X", typing: true },
      { id: "copy", label: "Copy", keys: "Ctrl+C", typing: true },
      { id: "paste", label: "Paste", keys: "Ctrl+V", typing: true },
      "separator",
      { id: "select-all", label: "Select all", keys: "Ctrl+A", typing: true },
    ],
  },
  {
    label: "View",
    entries: [
      { id: "command-palette", label: "Command palette…", keys: "Ctrl+Shift+P" },
      "separator",
      ...views.map(({ value, label }) => ({ id: `view-${value}`, label })),
      "separator",
      { id: "toggle-sidebar", label: "Sidebar", keys: "Ctrl+B", checked: (s) => s.sidebarOpen },
      { id: "toggle-inspector", label: "Inspector", checked: (s) => s.inspectorOpen },
      "separator",
      {
        label: "Theme",
        items: themes.map(({ value, label }) => ({ id: `theme-${value}`, label })),
        selected: (s) => `theme-${s.theme}`,
      },
    ],
  },
  {
    label: "Query",
    entries: [
      { id: "run", label: "Run", keys: "Ctrl+Enter" },
      { id: "stop", label: "Stop" },
      "separator",
      { id: "explain", label: "Explain" },
      { id: "format", label: "Format" },
    ],
  },
  {
    label: "Help",
    entries: [
      { id: "shortcuts", label: "Keyboard shortcuts" },
      { id: "about", label: "About QueryCraft" },
    ],
  },
];

/** Edit item id → Monaco command */
const editorCommands = {
  undo: "undo",
  redo: "redo",
  cut: "editor.action.clipboardCutAction",
  copy: "editor.action.clipboardCopyAction",
  paste: "editor.action.clipboardPasteAction",
  "select-all": "editor.action.selectAll",
} as const;

/** Runs an Edit item on the focused field: Monaco through its own commands, anything else natively */
async function edit(command: keyof typeof editorCommands) {
  if (document.activeElement?.closest(".monaco-editor")) {
    // Already loaded: the editor has focus
    const { monaco } = await import("@/lib/monaco");
    const editor = monaco.editor.getEditors().find((e) => e.hasTextFocus());
    if (editor) return editor.trigger("menu", editorCommands[command], null);
  }
  if (command === "paste") document.execCommand("insertText", false, await navigator.clipboard.readText());
  else document.execCommand(command === "select-all" ? "selectAll" : command);
}

export function createActions(openConnect: () => void): Actions {
  const ui = useUi.getState;
  return {
    "new-connection": openConnect,
    ...(isTauri && { exit: () => void getCurrentWindow().close() }),
    ...Object.fromEntries(Object.keys(editorCommands).map((id) => [id, () => void edit(id as keyof typeof editorCommands)])),
    ...Object.fromEntries(views.map(({ value }) => [`view-${value}`, () => ui().setView(value)])),
    "toggle-sidebar": () => ui().toggleSidebar(),
    "toggle-inspector": () => ui().toggleInspector(),
    ...Object.fromEntries(themes.map(({ value }) => [`theme-${value}`, () => ui().setTheme(value)])),
    run: () => void useQuery.getState().run(),
  };
}

/** Runs items picked in the native macOS menu */
export function useNativeMenu(actions: Actions) {
  useEffect(() => {
    if (!isMac || !isTauri) return;
    // Same name as MENU_EVENT in src-tauri/src/chrome.rs
    const unlisten = listen<string>("menu", (event) => actions[event.payload]?.());
    return () => void unlisten.then((stop) => stop());
  }, [actions]);
}

function matches(keys: string, event: KeyboardEvent) {
  const parts = keys.split("+");
  const key = parts.pop()!;
  return (
    event.ctrlKey === parts.includes("Ctrl") &&
    event.shiftKey === parts.includes("Shift") &&
    event.altKey === parts.includes("Alt") &&
    event.key.toLowerCase() === key.toLowerCase()
  );
}

const boundItems = menus
  .flatMap((menu) => menu.entries)
  .filter((entry): entry is MenuItem & { keys: string } => typeof entry === "object" && "id" in entry && !!entry.keys && !entry.typing);

/** The in-app menu's shortcuts, app-wide. macOS needs none: its native menu owns them. */
export function useMenuShortcuts(actions: Actions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Every bound shortcut uses Ctrl; skip plain typing. defaultPrevented: the editor handled it
      // (Ctrl+Enter runs the query from Monaco)
      if (!event.ctrlKey || event.defaultPrevented) return;
      const item = boundItems.find((item) => matches(item.keys, event));
      const action = item && actions[item.id];
      if (!action) return;
      event.preventDefault();
      action();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions]);
}
