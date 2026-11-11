import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as monaco from './monaco-editor';

// Bundled Monaco instead of @monaco-editor/react's default CDN copy, so the editor works offline
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export const THEME = 'querycraft';

const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;

// Monaco only takes hex colors; the design tokens are oklch, so paint one pixel and read it back
function tokenHex(name: string) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return '#' + [r, g, b, a].map((n) => n.toString(16).padStart(2, '0')).join('');
}

// Rebuilt from the CSS tokens on every theme change, so index.css stays the only source of colors
function applyTheme() {
    const hex = (name: string) => tokenHex(name).slice(1, 7);
    const dark = document.documentElement.dataset.theme === 'dark';
    monaco.editor.defineTheme(THEME, {
        base: dark ? 'vs-dark' : 'vs',
        // No inherited token rules: the base themes style `string.sql`, `comment.quote.sql`… directly,
        // which would override these. Bare names match every sub-token by prefix.
        inherit: false,
        rules: [
            { token: '', foreground: hex('--fg') },
            ...(
                [
                    ['keyword', '--syn-kw'],
                    ['predefined', '--syn-fn'],
                    ['string', '--syn-str'],
                    ['number', '--syn-num'],
                    ['comment', '--syn-com'],
                    ['operator', '--fg2'],
                    ['delimiter', '--fg3'],
                ] as const
            ).map(([token, color]) => ({ token, foreground: hex(color), fontStyle: token === 'comment' ? 'italic' : '' })),
        ],
        colors: {
            'editor.background': tokenHex('--editor-bg'),
            'editor.foreground': tokenHex('--fg'),
            'editor.lineHighlightBackground': tokenHex('--hover'),
            'editor.lineHighlightBorder': '#00000000',
            'editor.selectionBackground': tokenHex('--sel'),
            'editor.inactiveSelectionBackground': tokenHex('--sel'),
            'editorCursor.foreground': tokenHex('--primary'),
            'editorLineNumber.foreground': tokenHex('--fg4'),
            'editorLineNumber.activeForeground': tokenHex('--fg2'),
            'editorIndentGuide.background1': tokenHex('--border-soft'),
            'editorWidget.background': tokenHex('--elev'),
            'editorWidget.border': tokenHex('--border'),
            // Every suggest-list color from the tokens: the light base theme's white selected text vanishes on --primary-soft
            'editorSuggestWidget.background': tokenHex('--elev'),
            'editorSuggestWidget.border': tokenHex('--border'),
            'editorSuggestWidget.foreground': tokenHex('--fg'),
            'editorSuggestWidget.selectedBackground': tokenHex('--primary-soft'),
            'editorSuggestWidget.selectedForeground': tokenHex('--fg'),
            'editorSuggestWidget.selectedIconForeground': tokenHex('--fg2'),
            'editorSuggestWidget.highlightForeground': tokenHex('--primary-text'),
            'editorSuggestWidget.focusHighlightForeground': tokenHex('--primary-text'),
            'list.activeSelectionForeground': tokenHex('--fg'),
            'list.activeSelectionIconForeground': tokenHex('--fg2'),
            'list.hoverBackground': tokenHex('--hover'),
            focusBorder: tokenHex('--focus'),
            'scrollbarSlider.background': tokenHex('--hover'),
        },
    });
    monaco.editor.setTheme(THEME);
}

applyTheme();
// src/stores/ui.ts sets data-theme on <html>; follow it, including system theme flips
new MutationObserver(applyTheme).observe(document.documentElement, { attributeFilter: ['data-theme'] });

export const FONT_FAMILY = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();

// Monaco measures glyphs once; if the font arrives later the cursor drifts off the text.
// Wait for this font specifically: fonts.ready can resolve before Monaco has requested it.
void document.fonts.load(`13px ${FONT_FAMILY}`).then(() => monaco.editor.remeasureFonts());

export { monaco };
