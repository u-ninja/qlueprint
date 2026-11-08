// Slim Monaco build, bundled with the app so the editor works offline: every editor feature
// (find, multi-cursor, folding, suggest…) but only the PostgreSQL grammar, without the
// TypeScript/CSS/HTML/JSON language services and 80 other grammars that editor.main.js adds.
import 'monaco-editor/features/register.all.js';
import 'monaco-editor/languages/definitions/pgsql/register.js';

export * from 'monaco-editor/editor/editor.api.js';
