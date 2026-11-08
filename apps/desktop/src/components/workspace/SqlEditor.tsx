import Editor, { type OnMount } from '@monaco-editor/react';
import { FONT_FAMILY, monaco, THEME } from '@/lib/monaco';
import { useQuery } from '@/stores/query';
import { runShortcut } from '@/lib/utils';

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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void useQuery.getState().run());
    editor.focus();
};

const handleChange = (value: string | undefined) => useQuery.getState().setSql(value ?? '');

// Default export so the workspace can lazy-load Monaco, which is most of the app's JavaScript
export default function SqlEditor() {
    return (
        <Editor
            language="pgsql"
            theme={THEME}
            // Uncontrolled: Monaco owns the text, the store only mirrors it for Run and the saved draft
            defaultValue={useQuery.getState().sql}
            onChange={handleChange}
            onMount={handleMount}
            options={options}
            loading={null}
        />
    );
}
