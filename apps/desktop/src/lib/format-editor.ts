import { isMac } from './utils';

/** Shown next to Format in the toolbar and menus: VS Code's "Format Document" keys, which Monaco binds itself */
export const formatShortcut = isMac ? '⇧⌥F' : 'Shift+Alt+F';

/**
 * Formats the query editor: the selection when there is one, else the whole query. Through Monaco's own
 * format action, so it's one undo step. Loads Monaco on demand: the toolbar and menus live outside its chunk.
 */
export async function formatEditor() {
    const { monaco } = await import('./monaco');
    const editor = monaco.editor.getEditors()[0];
    if (!editor) return;
    const selection = editor.getSelection();
    editor.focus();
    await editor.getAction(selection && !selection.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument')?.run();
}
