import Editor, { type OnMount } from '@monaco-editor/react';
import { FONT_FAMILY, monaco, THEME } from '@/lib/monaco';
import { registerSqlCompletion } from '@/lib/sql-complete';
import { registerSqlDiagnostics } from '@/lib/sql-diagnostics';
import { formatSql } from '@/lib/sql-format';
import { useConnections } from '@/stores/connections';
import { activeConnection, currentQuery, useQuery } from '@/stores/query';
import { isMac, runShortcut } from '@/lib/utils';

const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    fontFamily: FONT_FAMILY,
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 12 },
    tabSize: 2,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    placeholder: `Write a query. ${runShortcut} runs it, or just the selected part.`,
};

let formattingRegistered = false;

/**
 * Format Document (⇧⌥F, or the editor's right-click menu) and Format Selection, in the dialect of the
 * tab's connection. Once per app: Monaco providers are global.
 */
function registerSqlFormatting() {
    if (formattingRegistered) return;
    formattingRegistered = true;
    const edits = (model: monaco.editor.ITextModel, range: monaco.IRange, tabSize: number): monaco.languages.TextEdit[] => {
        const tab = currentQuery(useQuery.getState());
        const kind = activeConnection(useConnections.getState().connections, tab.connectionId)?.kind;
        try {
            return [{ range, text: formatSql(model.getValueInRange(range), kind, tabSize) }];
        } catch (error) {
            // Text it can't parse stays as it is; Messages says why
            const text = `Couldn’t format: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
            useQuery.setState((s) => ({ messages: [...s.messages.slice(-499), { at: new Date(), ok: false, text }] }));
            return [];
        }
    };
    monaco.languages.registerDocumentFormattingEditProvider('pgsql', {
        provideDocumentFormattingEdits: (model, options) => edits(model, model.getFullModelRange(), options.tabSize),
    });
    monaco.languages.registerDocumentRangeFormattingEditProvider('pgsql', {
        provideDocumentRangeFormattingEdits: (model, range, options) => edits(model, range, options.tabSize),
    });
}

registerSqlCompletion();
registerSqlDiagnostics();
registerSqlFormatting();

const handleMount: OnMount = (editor) => {
    const { setHasSelection, setReadSelection } = useQuery.getState();
    // Run executes the selection when there is one. The store keeps only whether one exists;
    // the text is read from the editor when Run needs it.
    const selected = () => {
        const selection = editor.getSelection();
        return selection && !selection.isEmpty() ? (editor.getModel()?.getValueInRange(selection) ?? '') : '';
    };
    setReadSelection(selected);
    editor.onDidChangeCursorSelection(({ selection }) => {
        if (useQuery.getState().hasSelection === selection.isEmpty()) setHasSelection(!selection.isEmpty());
    });
    editor.onDidDispose(() => {
        setReadSelection(() => '');
        setHasSelection(false);
    });
    // ⌘/Ctrl+Enter runs, ⌘/Ctrl+S saves, ⌘/Ctrl+E explains (with ⇧, analyzed). Caught on the editor's
    // container in the capture phase, before Monaco's own keybindings (⌘Enter is "insert line below"
    // there) can claim the key. Both ⌘ and Ctrl work on macOS: Ctrl+Enter is what people coming from
    // other SQL tools press. Not Ctrl+E there, which moves to the end of the line
    editor.getContainerDomNode().addEventListener(
        'keydown',
        (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
            const key = e.key.toLowerCase();
            if (key === 'e' && (e.metaKey || !isMac)) void useQuery.getState().explain(e.shiftKey);
            else if (e.shiftKey) return;
            else if (key === 'enter') void useQuery.getState().run();
            else if (key === 's') useQuery.getState().save();
            else return;
            e.preventDefault();
            e.stopPropagation();
        },
        true,
    );
    editor.focus();
};

const handleChange = (value: string | undefined) => useQuery.getState().setSql(value ?? '');

// Default export so the workspace can lazy-load Monaco, which is most of the app's JavaScript
export default function SqlEditor() {
    const id = useQuery((s) => currentQuery(s).id);
    return (
        <Editor
            language="pgsql"
            theme={THEME}
            // One Monaco model per query tab, keyed by its id: switching tabs swaps models, so each keeps
            // its own undo history, cursor and scroll. shortcut: a closed tab's model stays in memory until
            // the app restarts, dispose it in closeTab if people open hundreds of tabs
            path={id}
            // Uncontrolled: Monaco owns the text, the store only mirrors it for Run and the saved draft.
            // Read when a tab's model is first created, i.e. its restored or starter SQL
            defaultValue={currentQuery(useQuery.getState()).sql}
            onChange={handleChange}
            onMount={handleMount}
            options={options}
            loading={null}
        />
    );
}
