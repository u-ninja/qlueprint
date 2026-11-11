// SQL formatting: sql-formatter, the engine prettier-plugin-sql runs, used directly. Only the four
// dialects QueryCraft connects to are imported, so the other nineteen don't ship.
import { formatDialect, mysql, postgresql, sqlite, transactsql } from 'sql-formatter';

const dialects = { postgres: postgresql, mysql, mssql: transactsql, sqlite };

/**
 * The SQL laid out the way the database's own dialect reads it: keywords upper case, one clause per
 * line, a blank line between statements. Throws when it can't parse the text.
 */
export function formatSql(sql: string, kind: keyof typeof dialects | undefined, tabWidth: number) {
    return formatDialect(sql, {
        dialect: dialects[kind ?? 'postgres'],
        tabWidth,
        keywordCase: 'upper',
        dataTypeCase: 'upper',
        functionCase: 'upper',
        linesBetweenQueries: 1,
    });
}
