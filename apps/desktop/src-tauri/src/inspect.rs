//! The inspector's view of one table: columns with their keys, indexes, and the size, row
//! estimate and DDL the database itself reports. Nothing is guessed: what a database doesn't
//! supply stays `None` (SQLite has no row estimate or size; Postgres has no CREATE TABLE text).

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::{AssertSqlSafe, Row};
use tauri::State;

use std::time::Instant;

use crate::audit::{Audit, EventKind};
use crate::db::{CommandError, Connections, ErrorCode, Pool, mssql_type, query_failed, require};
use crate::mssql;
use crate::query::{audit_base, elapsed_ms, non_empty, run_details};
use crate::saved::Saved;

#[derive(Serialize, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    columns: Vec<DetailColumn>,
    indexes: Vec<IndexInfo>,
    view: bool,
    /// The planner's estimate (Postgres reltuples, MySQL TABLE_ROWS), not a count
    #[specta(type = Option<specta_typescript::Number>)]
    estimated_rows: Option<i64>,
    /// Table plus its indexes, in bytes
    #[specta(type = Option<specta_typescript::Number>)]
    size_bytes: Option<i64>,
    /// Only when the database gives the exact text: MySQL's SHOW CREATE, SQLite's stored SQL, a Postgres view
    ddl: Option<String>,
    /// Single-column foreign keys in other tables that point at this one
    referenced_by: Vec<IncomingRef>,
}

#[derive(Serialize, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetailColumn {
    name: String,
    type_name: String,
    nullable: bool,
    default: Option<String>,
    /// "PK", "FK" or "UQ": the strongest key the column is part of
    key: Option<String>,
    /// For a foreign key, the table it points at, its schema ("main" on SQLite) and the column
    references: Option<String>,
    references_schema: Option<String>,
    /// None when SQLite's key names no column and the target's primary key isn't a single column
    references_column: Option<String>,
    /// The allowed values of an enum column (MySQL `enum(...)`, a Postgres enum type), in order
    enum_values: Option<Vec<String>>,
}

#[derive(Serialize, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingRef {
    schema: String,
    table: String,
    column: String,
    /// The column of this table it points at
    references_column: String,
}

#[derive(Serialize, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    name: String,
    /// Its columns, or its definition where that's all the database gives
    columns: String,
    unique: bool,
    primary: bool,
}

type ColumnRow = (
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
type IncomingRow = (String, String, String, String);
/// rows estimate, size, is a view, view definition
type PgTableRow = (Option<i64>, Option<i64>, i64, Option<String>);
/// rows estimate, size, is a view
type MysqlTableRow = (Option<i64>, Option<i64>, i64);
type IndexRow = (String, Option<String>, i64, i64);

fn column(
    (name, type_name, nullable, default, key, references_schema, references, references_column): ColumnRow,
) -> DetailColumn {
    // A foreign key column that isn't also part of the primary key or a unique one
    let key = key.or_else(|| references.as_ref().map(|_| "FK".to_owned()));
    DetailColumn {
        enum_values: mysql_enum(&type_name),
        name,
        type_name,
        nullable: nullable != 0,
        default,
        key,
        references,
        references_schema,
        references_column,
    }
}

fn incoming((schema, table, column, references_column): IncomingRow) -> IncomingRef {
    IncomingRef {
        schema,
        table,
        column,
        references_column,
    }
}

/// SQL Server's index rows, one per key column in order, as one row per index with its columns
/// joined like the other engines'. O(rows).
fn mssql_indexes(rows: Vec<Vec<Option<String>>>) -> Vec<IndexInfo> {
    let mut merged: Vec<IndexRow> = Vec::new();
    for mut r in rows {
        let (name, column) = (mssql::text(&mut r[0]), r[1].take());
        match merged.last_mut() {
            Some((last, columns, ..)) if *last == name => {
                if let Some(column) = column {
                    let joined = columns.get_or_insert_with(String::new);
                    if !joined.is_empty() {
                        joined.push_str(", ");
                    }
                    joined.push_str(&column);
                }
            }
            _ => merged.push((
                name,
                column,
                mssql::int(&mut r[2]).unwrap_or(0),
                mssql::int(&mut r[3]).unwrap_or(0),
            )),
        }
    }
    merged.into_iter().map(index).collect()
}

fn index((name, columns, unique, primary): IndexRow) -> IndexInfo {
    IndexInfo {
        name,
        columns: columns.unwrap_or_default(),
        unique: unique != 0,
        primary: primary != 0,
    }
}

const PG_COLUMNS: &str = r"
    SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::int8,
           pg_get_expr(d.adbin, d.adrelid),
           (SELECT CASE con.contype WHEN 'p' THEN 'PK' WHEN 'u' THEN 'UQ' END FROM pg_constraint con
             WHERE con.conrelid = c.oid AND a.attnum = ANY(con.conkey) AND con.contype IN ('p', 'u')
             ORDER BY con.contype = 'p' DESC LIMIT 1),
           f.nspname, f.relname, f.attname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    -- The referenced column sits at the same position in confkey as this one in conkey
    LEFT JOIN LATERAL (
        SELECT fn.nspname::text, fc.relname::text, fa.attname::text
        FROM pg_constraint con
        JOIN pg_class fc ON fc.oid = con.confrelid
        JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[array_position(con.conkey, a.attnum)]
        WHERE con.conrelid = c.oid AND con.contype = 'f' AND a.attnum = ANY(con.conkey)
        ORDER BY con.conname LIMIT 1
    ) f(nspname, relname, attname) ON true
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

/// Each enum-typed column's labels; a domain over an enum or an array of one stays text
const PG_ENUMS: &str = r"
    SELECT a.attname::text, array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_enum e ON e.enumtypid = a.atttypid
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    GROUP BY a.attname";

// Composite foreign keys are left out here: one column can't filter to the rows they point from
const PG_INCOMING: &str = r"
    SELECT n.nspname::text, c.relname::text, a.attname::text, fa.attname::text
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
      AND con.confrelid = (SELECT t.oid FROM pg_class t JOIN pg_namespace tn ON tn.oid = t.relnamespace
                            WHERE tn.nspname = $1 AND t.relname = $2)
    ORDER BY 1, 2, 3";

const PG_INDEXES: &str = r"
    SELECT i.relname::text, pg_get_indexdef(ix.indexrelid), ix.indisunique::int8, ix.indisprimary::int8
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
    ORDER BY ix.indisprimary DESC, 1";

// reltuples is -1 until the table is first analyzed: no estimate then
const PG_TABLE: &str = r"
    SELECT NULLIF(c.reltuples, -1)::int8,
           -- A partitioned table stores nothing itself: its size is its partitions' (as the explorer shows)
           CASE c.relkind WHEN 'p' THEN (SELECT sum(pg_total_relation_size(relid))::int8 FROM pg_partition_tree(c.oid))
                          ELSE pg_total_relation_size(c.oid) END,
           (c.relkind IN ('v', 'm'))::int8,
           CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2";

const MYSQL_COLUMNS: &str = r"
    SELECT c.COLUMN_NAME, c.COLUMN_TYPE, CAST(c.IS_NULLABLE = 'YES' AS SIGNED), c.COLUMN_DEFAULT,
           CASE c.COLUMN_KEY WHEN 'PRI' THEN 'PK' WHEN 'UNI' THEN 'UQ' END,
           k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
    FROM information_schema.COLUMNS c
    LEFT JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
     AND k.REFERENCED_TABLE_NAME IS NOT NULL
     AND k.CONSTRAINT_NAME = (SELECT MIN(k2.CONSTRAINT_NAME) FROM information_schema.KEY_COLUMN_USAGE k2
                              WHERE k2.TABLE_SCHEMA = c.TABLE_SCHEMA AND k2.TABLE_NAME = c.TABLE_NAME
                                AND k2.COLUMN_NAME = c.COLUMN_NAME AND k2.REFERENCED_TABLE_NAME IS NOT NULL)
    WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
    ORDER BY c.ORDINAL_POSITION";

// Single-column foreign keys only, as for Postgres
const MYSQL_INCOMING: &str = r"
    SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE k
    WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
      AND NOT EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE o
                      WHERE o.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND o.TABLE_NAME = k.TABLE_NAME
                        AND o.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND o.ORDINAL_POSITION > 1)
    ORDER BY 1, 2, 3";

const MYSQL_INDEXES: &str = r"
    SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '),
           CAST(MIN(NON_UNIQUE) = 0 AS SIGNED), CAST(INDEX_NAME = 'PRIMARY' AS SIGNED)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    GROUP BY INDEX_NAME
    ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME";

const MYSQL_TABLE: &str = r"
    SELECT CAST(TABLE_ROWS AS SIGNED), CAST(DATA_LENGTH + INDEX_LENGTH AS SIGNED), CAST(TABLE_TYPE = 'VIEW' AS SIGNED)
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

const SQLITE_COLUMNS: &str = r#"
    SELECT p.name, p.type, p."notnull" = 0, p.dflt_value, CASE WHEN p.pk > 0 THEN 'PK' END,
           CASE WHEN f."table" IS NOT NULL THEN 'main' END, f."table",
           -- No "to" column means the target's primary key, usable only when it's a single column
           coalesce(f."to", (SELECT CASE WHEN count(*) = 1 THEN max(t.name) END
                             FROM pragma_table_info(f."table") t WHERE t.pk > 0))
    FROM pragma_table_info(?1) p
    LEFT JOIN pragma_foreign_key_list(?1) f
      ON f."from" = p.name AND f.id = (SELECT min(g.id) FROM pragma_foreign_key_list(?1) g WHERE g."from" = p.name)
    ORDER BY p.cid"#;

// Single-column foreign keys only; a key with no "to" points at this table's (single) primary key
const SQLITE_INCOMING: &str = r#"
    SELECT 'main', m.name, f."from",
           coalesce(f."to", (SELECT CASE WHEN count(*) = 1 THEN max(t.name) END
                             FROM pragma_table_info(?1) t WHERE t.pk > 0)) AS target
    FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND f."table" = ?1 COLLATE NOCASE AND target IS NOT NULL
      AND (SELECT count(*) FROM pragma_foreign_key_list(m.name) g WHERE g.id = f.id) = 1
    ORDER BY 2, 3"#;

const SQLITE_INDEXES: &str = r#"
    SELECT il.name, (SELECT group_concat(ii.name, ', ') FROM pragma_index_info(il.name) ii),
           il."unique", il.origin = 'pk'
    FROM pragma_index_list(?1) il
    ORDER BY il.origin = 'pk' DESC, il.name"#;

const SQLITE_TABLE: &str = "SELECT type = 'view', sql FROM sqlite_schema WHERE name = ?1";

// SQL Server: four result sets in one round trip, each shaped like the other engines' rows:
// columns, indexes (one row per key column, joined in Rust: FOR XML PATH fails on Fabric and
// Synapse, STRING_AGG on SQL Server 2016), single-column foreign keys pointing here, then the table.
// Fabric and Synapse (EngineEdition 11, 6) keep data outside SQL Server's pages: size unknown there.
const MSSQL_DETAILS: &str = concat!(
    "DECLARE @id int = OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2));
    SELECT c.name, ",
    mssql_type!(),
    ", CAST(c.is_nullable AS int), OBJECT_DEFINITION(c.default_object_id),
           (SELECT TOP (1) CASE k.type WHEN 'PK' THEN 'PK' ELSE 'UQ' END FROM sys.key_constraints k
             JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id
             WHERE k.parent_object_id = @id AND ic.column_id = c.column_id
             ORDER BY CASE k.type WHEN 'PK' THEN 0 ELSE 1 END),
           f.ref_schema, f.ref_table, f.ref_column
    FROM sys.columns c
    OUTER APPLY (SELECT TOP (1) SCHEMA_NAME(rt.schema_id) AS ref_schema, rt.name AS ref_table, rc.name AS ref_column
                 FROM sys.foreign_key_columns fkc
                 JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
                 JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                 WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
                 ORDER BY fk.name) f
    WHERE c.object_id = @id
    ORDER BY c.column_id;

    SELECT i.name, col.name, CAST(i.is_unique AS int), CAST(i.is_primary_key AS int)
    FROM sys.indexes i
    LEFT JOIN sys.index_columns ic
      ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    LEFT JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
    WHERE i.object_id = @id AND i.type > 0
    ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal;

    SELECT SCHEMA_NAME(t.schema_id), t.name, pc.name, rc.name
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.objects t ON t.object_id = fk.parent_object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    WHERE fk.referenced_object_id = @id
      AND (SELECT COUNT(*) FROM sys.foreign_key_columns x WHERE x.constraint_object_id = fk.object_id) = 1
    ORDER BY 1, 2, 3;

    -- Heap or clustered index rows only, so nonclustered indexes don't count a row twice
    SELECT (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)),
           CASE WHEN CAST(SERVERPROPERTY('EngineEdition') AS int) NOT IN (6, 11) THEN
           (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p
            JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE p.object_id = o.object_id) END,
           CASE WHEN o.type = 'V' THEN 1 ELSE 0 END,
           CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) END
    FROM sys.objects o WHERE o.object_id = @id"
);

/// A stored procedure's or function's definition as the database writes it (Postgres: the overload
/// `args` names), to open in a query tab. Metadata only, so it isn't audited.
#[tauri::command]
#[specta::specta]
pub async fn routine_definition(
    id: String,
    database: Option<String>,
    schema: String,
    name: String,
    procedure: bool,
    args: Option<String>,
    connections: State<'_, Connections>,
) -> Result<String, CommandError> {
    require(&name, "Name")?;
    let open = connections.get(&id)?;
    let definition = match open.pool_for(database.as_deref()).await? {
        Pool::Postgres(pool) => sqlx::query_scalar::<_, Option<String>>(
            "SELECT pg_get_functiondef(to_regprocedure(quote_ident($1) || '.' || quote_ident($2) || '(' || $3 || ')'))",
        )
        .bind(&schema)
        .bind(&name)
        .bind(args.as_deref().unwrap_or(""))
        .fetch_one(&pool)
        .await
        .map_err(query_failed)?,
        // SHOW CREATE has no placeholders: names are backquoted (a backquote inside doubled)
        Pool::Mysql(pool) => {
            let kind = if procedure { "PROCEDURE" } else { "FUNCTION" };
            let sql = format!(
                "SHOW CREATE {kind} {}.{}",
                quote_ident(&schema, '`'),
                quote_ident(&name, '`')
            );
            let row = sqlx::raw_sql(AssertSqlSafe(sql))
                .fetch_one(&pool)
                .await
                .map_err(query_failed)?;
            row.try_get::<Option<String>, _>(2).map_err(query_failed)?
        }
        Pool::Mssql(pool) => mssql::catalog_rows(
            &pool,
            "SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@P1) + '.' + QUOTENAME(@P2)))",
            &[&schema, &name],
        )
        .await?
        .into_iter()
        .next()
        .and_then(|mut r| r[0].take()),
        Pool::Sqlite(_) => None,
    };
    // NULL: it's gone, or this login may run it but not read it
    definition.ok_or_else(|| {
        CommandError::new(
            ErrorCode::QueryFailed,
            format!("{schema}.{name}’s definition isn’t readable with this login."),
        )
    })
}

/// Everything the inspector shows about `schema.table` in `database` (Postgres and SQL Server:
/// that database's pool; MySQL: the schema is the database; SQLite: "main"). Metadata only, so it
/// isn't audited.
#[tauri::command]
#[specta::specta]
pub async fn table_details(
    id: String,
    database: Option<String>,
    schema: String,
    table: String,
    connections: State<'_, Connections>,
) -> Result<TableDetails, CommandError> {
    require(&table, "Table")?;
    let open = connections.get(&id)?;
    match open.pool_for(database.as_deref()).await? {
        Pool::Postgres(pool) => {
            // Independent catalog reads: each takes its own pool connection, so they run at once
            let (columns, enums, indexes, referenced_by, (rows, size, view, view_def)) =
                tokio::try_join!(
                    sqlx::query_as::<_, ColumnRow>(PG_COLUMNS)
                        .bind(&schema)
                        .bind(&table)
                        .fetch_all(&pool),
                    sqlx::query_as::<_, (String, Vec<String>)>(PG_ENUMS)
                        .bind(&schema)
                        .bind(&table)
                        .fetch_all(&pool),
                    sqlx::query_as::<_, IndexRow>(PG_INDEXES)
                        .bind(&schema)
                        .bind(&table)
                        .fetch_all(&pool),
                    sqlx::query_as::<_, IncomingRow>(PG_INCOMING)
                        .bind(&schema)
                        .bind(&table)
                        .fetch_all(&pool),
                    sqlx::query_as::<_, PgTableRow>(PG_TABLE)
                        .bind(&schema)
                        .bind(&table)
                        .fetch_one(&pool),
                )
                .map_err(query_failed)?;
            let mut enums: std::collections::HashMap<_, _> = enums.into_iter().collect();
            Ok(TableDetails {
                columns: columns
                    .into_iter()
                    .map(|row| {
                        let mut c = column(row);
                        c.enum_values = enums.remove(&c.name);
                        c
                    })
                    .collect(),
                indexes: indexes.into_iter().map(index).collect(),
                view: view != 0,
                estimated_rows: rows,
                size_bytes: size,
                ddl: view_def.map(|def| {
                    format!(
                        "CREATE VIEW {}.{} AS\n{}",
                        quote_ident(&schema, '"'),
                        quote_ident(&table, '"'),
                        def.trim_end()
                    )
                }),
                referenced_by: referenced_by.into_iter().map(incoming).collect(),
            })
        }
        Pool::Mysql(pool) => {
            // SHOW CREATE can't take parameters: both names are quoted as identifiers. SHOW
            // CREATE TABLE gives a view's CREATE VIEW too, so it runs alongside the rest
            let show = format!(
                "SHOW CREATE TABLE {}.{}",
                quote_ident(&schema, '`'),
                quote_ident(&table, '`')
            );
            // No DDL (e.g. no privilege for it) leaves the rest of the details
            let ddl = async {
                Ok(sqlx::raw_sql(AssertSqlSafe(show))
                    .fetch_one(&pool)
                    .await
                    .ok()
                    .and_then(|row| row.try_get::<String, _>(1).ok()))
            };
            let (columns, indexes, referenced_by, (rows, size, view), ddl) = tokio::try_join!(
                sqlx::query_as::<_, ColumnRow>(MYSQL_COLUMNS)
                    .bind(&schema)
                    .bind(&table)
                    .fetch_all(&pool),
                sqlx::query_as::<_, IndexRow>(MYSQL_INDEXES)
                    .bind(&schema)
                    .bind(&table)
                    .fetch_all(&pool),
                sqlx::query_as::<_, IncomingRow>(MYSQL_INCOMING)
                    .bind(&schema)
                    .bind(&table)
                    .fetch_all(&pool),
                sqlx::query_as::<_, MysqlTableRow>(MYSQL_TABLE)
                    .bind(&schema)
                    .bind(&table)
                    .fetch_one(&pool),
                ddl,
            )
            .map_err(query_failed)?;
            Ok(TableDetails {
                columns: columns.into_iter().map(column).collect(),
                indexes: indexes.into_iter().map(index).collect(),
                view: view != 0,
                // Views have no rows or size of their own
                estimated_rows: rows.filter(|_| view == 0),
                size_bytes: size.filter(|_| view == 0),
                ddl,
                referenced_by: referenced_by.into_iter().map(incoming).collect(),
            })
        }
        Pool::Mssql(pool) => {
            let mut sets = mssql::catalog(&pool, MSSQL_DETAILS, &[&schema, &table])
                .await?
                .into_iter();
            let mut next = || sets.next().unwrap_or_default();
            let (columns, indexes, referenced_by, object) = (next(), next(), next(), next());
            let Some(mut object) = object.into_iter().next() else {
                return Err(CommandError::new(
                    ErrorCode::QueryFailed,
                    format!("{schema}.{table} doesn’t exist."),
                ));
            };
            let (text, number) = (mssql::text, mssql::int);
            let view = mssql::flag(&mut object[2]) == Some(true);
            Ok(TableDetails {
                columns: columns
                    .into_iter()
                    .map(|mut r| {
                        column((
                            text(&mut r[0]),
                            text(&mut r[1]),
                            number(&mut r[2]).unwrap_or(1),
                            r[3].take(),
                            r[4].take(),
                            r[5].take(),
                            r[6].take(),
                            r[7].take(),
                        ))
                    })
                    .collect(),
                indexes: mssql_indexes(indexes),
                view,
                estimated_rows: number(&mut object[0]).filter(|_| !view),
                size_bytes: number(&mut object[1]).filter(|_| !view),
                // A view's own CREATE VIEW text; tables have none to give
                ddl: object[3].take(),
                referenced_by: referenced_by
                    .into_iter()
                    .map(|mut r| {
                        incoming((
                            text(&mut r[0]),
                            text(&mut r[1]),
                            text(&mut r[2]),
                            text(&mut r[3]),
                        ))
                    })
                    .collect(),
            })
        }
        Pool::Sqlite(pool) => {
            let columns: Vec<ColumnRow> = sqlx::query_as(SQLITE_COLUMNS)
                .bind(&table)
                .fetch_all(&pool)
                .await
                .map_err(query_failed)?;
            let indexes: Vec<IndexRow> = sqlx::query_as(SQLITE_INDEXES)
                .bind(&table)
                .fetch_all(&pool)
                .await
                .map_err(query_failed)?;
            let referenced_by: Vec<IncomingRow> = sqlx::query_as(SQLITE_INCOMING)
                .bind(&table)
                .fetch_all(&pool)
                .await
                .map_err(query_failed)?;
            let (view, ddl): (i64, Option<String>) = sqlx::query_as(SQLITE_TABLE)
                .bind(&table)
                .fetch_one(&pool)
                .await
                .map_err(query_failed)?;
            Ok(TableDetails {
                columns: columns.into_iter().map(column).collect(),
                indexes: indexes.into_iter().map(index).collect(),
                view: view != 0,
                estimated_rows: None,
                size_bytes: None,
                ddl,
                referenced_by: referenced_by.into_iter().map(incoming).collect(),
            })
        }
    }
}

/// An identifier between `mark`s (a double quote, or MySQL's backtick), any inside it doubled
pub(crate) fn quote_ident(name: &str, mark: char) -> String {
    let doubled: String = [mark, mark].iter().collect();
    format!("{mark}{}{mark}", name.replace(mark, &doubled))
}

/// The values of a MySQL `enum('a','It''s')` column type; None for any other type. Backslash
/// escapes are kept as the escaped character (`\n` reads as `n`): MySQL itself shows quotes doubled.
fn mysql_enum(type_name: &str) -> Option<Vec<String>> {
    let body = type_name
        .get(..5)
        .filter(|p| p.eq_ignore_ascii_case("enum("))
        .and_then(|_| type_name[5..].strip_suffix(')'))?;
    let mut chars = body.chars().peekable();
    let mut values = Vec::new();
    loop {
        if chars.next()? != '\'' {
            return None;
        }
        let mut value = String::new();
        loop {
            match chars.next()? {
                '\'' if chars.peek() == Some(&'\'') => {
                    chars.next();
                    value.push('\'');
                }
                '\'' => break,
                '\\' => value.push(chars.next()?),
                c => value.push(c),
            }
        }
        values.push(value);
        match chars.next() {
            None => return Some(values),
            Some(',') => {}
            Some(_) => return None,
        }
    }
}

/// How each engine casts to text and numbers its parameters
#[derive(Clone, Copy)]
enum Dialect {
    Postgres,
    Mysql,
    Mssql,
    Sqlite,
}

/// Rows of `schema.table` for a foreign key picker: the key and an optional label, both as text.
/// With `searching`, the search (bound first, never spliced) matches the label case-insensitively
/// anywhere, or the key exactly; with no label column it matches anywhere in the key. An exact key
/// match sorts first. Without, the first rows by the key itself, so its index serves the LIMIT.
/// The limit is the last parameter.
fn lookup_sql(
    dialect: Dialect,
    schema: &str,
    table: &str,
    key: &str,
    label: Option<&str>,
    searching: bool,
) -> String {
    let (text, search, limit) = match (dialect, searching) {
        (Dialect::Postgres, true) => ("text", "$1", "$2"),
        (Dialect::Postgres, false) => ("text", "", "$1"),
        (Dialect::Mysql, _) => ("CHAR", "?", "?"),
        (Dialect::Mssql, true) => ("nvarchar(max)", "@P1", "@P2"),
        (Dialect::Mssql, false) => ("nvarchar(max)", "", "@P1"),
        (Dialect::Sqlite, true) => ("TEXT", "?1", "?2"),
        (Dialect::Sqlite, false) => ("TEXT", "", "?1"),
    };
    let quote = |name: &str| match dialect {
        Dialect::Mysql => quote_ident(name, '`'),
        Dialect::Mssql => mssql::quote(name),
        Dialect::Postgres | Dialect::Sqlite => quote_ident(name, '"'),
    };
    // SQL Server has TOP for LIMIT, and no boolean expressions to sort by
    let mssql = matches!(dialect, Dialect::Mssql);
    let (top, limit) = if mssql {
        (format!("TOP ({limit}) "), String::new())
    } else {
        (String::new(), format!(" LIMIT {limit}"))
    };
    let key = quote(key);
    let label = label.map(quote);
    let key_text = format!("CAST({key} AS {text})");
    let label_text = label.as_ref().map(|l| format!("CAST({l} AS {text})"));
    let select = format!(
        "SELECT {top}{key_text}, {} FROM {}.{}",
        label_text.as_deref().unwrap_or("NULL"),
        quote(schema),
        quote(table),
    );
    if !searching {
        return format!("{select} ORDER BY {key}{limit}");
    }
    let haystack = format!("lower({})", label_text.as_deref().unwrap_or(&key_text));
    let contains = match dialect {
        Dialect::Postgres => format!("strpos({haystack}, lower({search})) > 0"),
        Dialect::Mysql => format!("LOCATE(lower({search}), {haystack}) > 0"),
        Dialect::Mssql => format!("CHARINDEX(lower({search}), {haystack}) > 0"),
        Dialect::Sqlite => format!("instr({haystack}, lower({search})) > 0"),
    };
    let exact_first = if mssql {
        format!("CASE WHEN {key_text} = {search} THEN 0 ELSE 1 END")
    } else {
        format!("{key_text} = {search} DESC")
    };
    let order = label.map_or_else(|| key.clone(), |l| format!("{l}, {key}"));
    format!(
        "{select} WHERE {contains} OR {key_text} = {search} \
         ORDER BY {exact_first}, {order}{limit}"
    )
}

/// A key as text and its label
type Lookup = (Option<String>, Option<String>);

/// What `lookup_rows` reads: `key_column` of `schema.table`, and `label_column` to show beside it
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LookupRequest {
    database: Option<String>,
    schema: String,
    table: String,
    key_column: String,
    label_column: Option<String>,
    search: String,
    limit: u32,
}

/// Up to `limit` rows of `schema.table` to pick a foreign key value from (see `lookup_sql`).
/// `database` works as in `run_query`. It reads row data, so it's audited like a query run.
#[tauri::command]
#[specta::specta]
pub async fn lookup_rows(
    id: String,
    request: LookupRequest,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<Vec<(String, Option<String>)>, CommandError> {
    let LookupRequest {
        database,
        schema,
        table,
        key_column,
        label_column,
        search,
        limit,
    } = request;
    require(&table, "Table")?;
    require(&key_column, "Key column")?;
    let started = Instant::now();
    let database = non_empty(database);
    let open = connections.get(&id)?;
    let label = label_column.as_deref().filter(|l| !l.is_empty());
    let limit = i64::from(limit.clamp(1, 200));
    let searching = !search.is_empty();
    let (sql, result) = match open.pool_for(database.as_deref()).await? {
        Pool::Postgres(pool) => {
            let sql = lookup_sql(
                Dialect::Postgres,
                &schema,
                &table,
                &key_column,
                label,
                searching,
            );
            let mut query = sqlx::query_as::<_, Lookup>(AssertSqlSafe(sql.as_str()));
            if searching {
                query = query.bind(&search);
            }
            let rows = query.bind(limit).fetch_all(&pool).await;
            (sql, rows.map_err(query_failed))
        }
        Pool::Mysql(pool) => {
            // MySQL's schemas are its databases: the table is named with it, no USE needed
            let sql = lookup_sql(
                Dialect::Mysql,
                &schema,
                &table,
                &key_column,
                label,
                searching,
            );
            // `?` is positional: once for the match, the exact key and its sort
            let mut query = sqlx::query_as::<_, Lookup>(AssertSqlSafe(sql.as_str()));
            if searching {
                query = query.bind(&search).bind(&search).bind(&search);
            }
            let rows = query.bind(limit).fetch_all(&pool).await;
            (sql, rows.map_err(query_failed))
        }
        Pool::Mssql(pool) => {
            let sql = lookup_sql(
                Dialect::Mssql,
                &schema,
                &table,
                &key_column,
                label,
                searching,
            );
            let params: &[&dyn tiberius::ToSql] = if searching {
                &[&search, &limit]
            } else {
                &[&limit]
            };
            let rows = mssql::catalog_rows(&pool, &sql, params).await.map(|rows| {
                rows.into_iter()
                    .map(|mut r| (r[0].take(), r[1].take()))
                    .collect()
            });
            (sql, rows)
        }
        Pool::Sqlite(pool) => {
            let sql = lookup_sql(
                Dialect::Sqlite,
                &schema,
                &table,
                &key_column,
                label,
                searching,
            );
            let rows = sqlite_lookup(&pool, &sql, &search, limit).await;
            (sql, rows.map_err(query_failed))
        }
    };

    let outcome = result.as_ref().map(|rows| rows.len() as u64);
    let details = run_details(
        audit_base(&saved, &id, database.as_deref()),
        sql,
        elapsed_ms(started),
        outcome.map_err(CommandError::message),
    );
    audit.record(EventKind::QueryRun, Some(&id), details).await;
    // A NULL key can't be picked as a value
    Ok(result?
        .into_iter()
        .filter_map(|(key, label)| Some((key?, label)))
        .collect())
}

async fn sqlite_lookup(
    pool: &sqlx::SqlitePool,
    sql: &str,
    search: &str,
    limit: i64,
) -> Result<Vec<Lookup>, sqlx::Error> {
    let mut query = sqlx::query_as::<_, Lookup>(AssertSqlSafe(sql));
    if !search.is_empty() {
        query = query.bind(search);
    }
    query.bind(limit).fetch_all(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    #[test]
    fn joins_sql_server_index_columns_in_order() {
        let row = |cells: [Option<&str>; 4]| cells.map(|c| c.map(str::to_owned)).to_vec();
        let indexes = mssql_indexes(vec![
            row([Some("PK_orders"), Some("id"), Some("1"), Some("1")]),
            row([
                Some("IX_customer_day"),
                Some("customer_id"),
                Some("0"),
                Some("0"),
            ]),
            row([Some("IX_customer_day"), Some("day"), Some("0"), Some("0")]),
            // An index with no key columns (a columnstore one): no column row joined in
            row([Some("CCI_orders"), None, Some("0"), Some("0")]),
        ]);
        let info = |name: &str, columns: &str, unique, primary| IndexInfo {
            name: name.into(),
            columns: columns.into(),
            unique,
            primary,
        };
        assert_eq!(
            indexes,
            [
                info("PK_orders", "id", true, true),
                info("IX_customer_day", "customer_id, day", false, false),
                info("CCI_orders", "", false, false),
            ]
        );
    }

    #[tokio::test]
    async fn describes_sqlite_columns_keys_and_indexes() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
             CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), note TEXT DEFAULT 'none',
                                  owner INTEGER REFERENCES users);
             CREATE TABLE pairs (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
             CREATE TABLE links (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES pairs(a, b));
             CREATE INDEX orders_user ON orders(user_id);",
        )
        .execute(&pool)
        .await
        .unwrap();

        let columns: Vec<ColumnRow> = sqlx::query_as(SQLITE_COLUMNS)
            .bind("orders")
            .fetch_all(&pool)
            .await
            .unwrap();
        let columns: Vec<DetailColumn> = columns.into_iter().map(column).collect();
        assert_eq!(columns[0].key.as_deref(), Some("PK"));
        assert_eq!(
            (
                columns[1].key.as_deref(),
                columns[1].references_schema.as_deref(),
                columns[1].references.as_deref(),
                columns[1].references_column.as_deref(),
            ),
            (Some("FK"), Some("main"), Some("users"), Some("id"))
        );
        // No column named: resolved to the target's primary key
        assert_eq!(columns[3].references_column.as_deref(), Some("id"));
        assert_eq!(columns[0].references, None);

        let incoming_rows: Vec<IncomingRow> = sqlx::query_as(SQLITE_INCOMING)
            .bind("users")
            .fetch_all(&pool)
            .await
            .unwrap();
        let referenced_by: Vec<IncomingRef> = incoming_rows.into_iter().map(incoming).collect();
        assert_eq!(
            referenced_by
                .iter()
                .map(|r| (
                    r.schema.as_str(),
                    r.table.as_str(),
                    r.column.as_str(),
                    r.references_column.as_str()
                ))
                .collect::<Vec<_>>(),
            [
                ("main", "orders", "owner", "id"),
                ("main", "orders", "user_id", "id")
            ]
        );
        // The composite key from links is left out
        let to_pairs: Vec<IncomingRow> = sqlx::query_as(SQLITE_INCOMING)
            .bind("pairs")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(to_pairs.is_empty());
        assert_eq!(
            (columns[2].nullable, columns[2].default.as_deref()),
            (true, Some("'none'"))
        );

        let indexes: Vec<IndexRow> = sqlx::query_as(SQLITE_INDEXES)
            .bind("users")
            .fetch_all(&pool)
            .await
            .unwrap();
        let indexes: Vec<IndexInfo> = indexes.into_iter().map(index).collect();
        // The UNIQUE constraint's automatic index; SQLite reports no index for INTEGER PRIMARY KEY
        assert!(indexes.iter().any(|i| i.unique && i.columns == "email"));

        let (view, ddl): (i64, Option<String>) = sqlx::query_as(SQLITE_TABLE)
            .bind("orders")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(view, 0);
        assert!(ddl.unwrap().starts_with("CREATE TABLE orders"));
    }

    #[test]
    fn parses_mysql_enum_types() {
        assert_eq!(
            mysql_enum("enum('Draft','Submitted','It''s','a,b','back\\'slash')"),
            Some(vec![
                "Draft".into(),
                "Submitted".into(),
                "It's".into(),
                "a,b".into(),
                "back'slash".into()
            ])
        );
        assert_eq!(mysql_enum("ENUM('x')"), Some(vec!["x".into()]));
        assert_eq!(mysql_enum("varchar(20)"), None);
        assert_eq!(mysql_enum("enum('unterminated)"), None);
        assert_eq!(mysql_enum("set('a','b')"), None);
    }

    #[tokio::test]
    async fn looks_up_rows_by_label_and_key() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace'), (3, 'Alan'), (12, 'Linus'), (21, NULL);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let sql =
            |label, searching| lookup_sql(Dialect::Sqlite, "main", "users", "id", label, searching);
        let run = |sql: String, search: &'static str, limit| {
            let pool = pool.clone();
            async move { sqlite_lookup(&pool, &sql, search, limit).await.unwrap() }
        };
        let some = |k: &str, l: Option<&str>| (Some(k.to_owned()), l.map(str::to_owned));

        // Label contains, case-insensitive, sorted by label
        assert_eq!(
            run(sql(Some("name"), true), "a", 50).await,
            [
                some("1", Some("Ada")),
                some("3", Some("Alan")),
                some("2", Some("Grace"))
            ]
        );
        // The key matches exactly (21's label is NULL) and comes first
        assert_eq!(
            run(sql(Some("name"), true), "21", 50).await,
            [some("21", None)]
        );
        // Empty search: the first rows by key, up to the limit
        assert_eq!(
            run(sql(Some("name"), false), "", 2).await,
            [some("1", Some("Ada")), some("2", Some("Grace"))]
        );
        // No label: the key matches anywhere, ordered as numbers
        assert_eq!(
            run(sql(None, true), "1", 50).await,
            [some("1", None), some("12", None), some("21", None)]
        );
        // Quotes in names stay identifiers
        assert!(lookup_sql(Dialect::Mysql, "s", "t`x", "id", None, true).contains("`t``x`"));
        // SQL Server: TOP, bracket quoting, no boolean to sort by
        assert_eq!(
            lookup_sql(Dialect::Mssql, "dbo", "Order]s", "id", Some("name"), false),
            "SELECT TOP (@P1) CAST([id] AS nvarchar(max)), CAST([name] AS nvarchar(max)) FROM [dbo].[Order]]s] ORDER BY [id]"
        );
        assert!(
            lookup_sql(Dialect::Mssql, "dbo", "t", "id", None, true).ends_with(
                "WHERE CHARINDEX(lower(@P1), lower(CAST([id] AS nvarchar(max)))) > 0 OR CAST([id] AS nvarchar(max)) = @P1 \
                 ORDER BY CASE WHEN CAST([id] AS nvarchar(max)) = @P1 THEN 0 ELSE 1 END, [id]"
            )
        );
    }
}
