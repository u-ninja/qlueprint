// Reading table references out of SQL text for autocomplete: no parser, a regex over the statement

// "double", `backtick` or SQL Server's [bracket] quoting, the closing mark doubled inside
export const NAME = String.raw`"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[(?:[^\]]|\]\])+\]|[A-Za-z_][\w$]*`;
export const unquote = (name: string) => (/^["`[]/.test(name) ? name.slice(1, -1).replace(/""|``|\]\]/g, (q) => q[0]) : name);

// Words that can follow a table but aren't its alias
const NOT_ALIAS = new Set(
    'WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING GROUP ORDER LIMIT OFFSET SET VALUES HAVING UNION RETURNING AS WINDOW NATURAL WITH OUTPUT APPLY'.split(
        ' ',
    ),
);
/** A table named in a statement; `token` is the table name as written and `at` where it starts */
export type Ref = { schema?: string; table: string; alias?: string; token: string; at: number };

/** Tables the statement names after FROM / JOIN / UPDATE / INTO, with their aliases and positions */
export function referenced(sql: string): Ref[] {
    const pattern = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${NAME})(?:\s*\.\s*(${NAME}))?(?:\s+(?:as\s+)?(${NAME}))?`, 'gi');
    return [...sql.matchAll(pattern)].map((m) => {
        const [whole, a, b, alias] = m;
        const token = b ?? a;
        // The table token sits before any alias: search the text up to the alias, from the end
        const head = alias ? whole.slice(0, whole.lastIndexOf(alias)) : whole;
        return {
            schema: b ? unquote(a) : undefined,
            table: unquote(token),
            alias: alias && !NOT_ALIAS.has(alias.toUpperCase()) ? unquote(alias) : undefined,
            token,
            at: m.index + head.lastIndexOf(token),
        };
    });
}
