//! Run the SQL a user typed and return a bounded, display-ready result.

use std::time::Instant;

use futures_util::{Stream, TryStreamExt};
use serde::Serialize;
use specta::Type;
use sqlx::mysql::{MySqlQueryResult, MySqlRow};
use sqlx::postgres::{PgQueryResult, PgRow};
use sqlx::sqlite::{SqliteQueryResult, SqliteRow};
use sqlx::{AssertSqlSafe, Column, Either, Row, TypeInfo, ValueRef};
use tauri::State;

use crate::audit::{Audit, EventKind};
use crate::db::{CommandError, Connections, Pool, query_failed, require};
use crate::saved::Saved;

/// Rows kept per result. The rest are still read (to count them) but not stored,
/// so a large SELECT can't exhaust memory in Rust or in the UI.
pub const MAX_ROWS: usize = 1000;

#[derive(Debug, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    columns: Vec<ResultColumn>,
    /// Every cell as text, `null` for SQL NULL. Text keeps big integers, decimals and
    /// timestamps exact; a JS number would round anything past 2^53.
    rows: Vec<Vec<Option<String>>>,
    /// More than `MAX_ROWS` rows came back; `rows` holds the first `MAX_ROWS`.
    truncated: bool,
    /// For a SELECT, the total row count; otherwise rows inserted/updated/deleted.
    #[specta(type = specta_typescript::Number)]
    rows_affected: u64,
    elapsed_ms: u32,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    name: String,
    /// The database's own type name, e.g. `INT4` or `TEXT`. Empty when SQLite has none.
    type_name: String,
    /// How the UI should align and size the column.
    kind: ColumnKind,
}

/// Display family of a column, decided here where the driver's type info is.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ColumnKind {
    Number,
    Bool,
    Temporal,
    Uuid,
    Json,
    Binary,
    Text,
}

impl ColumnKind {
    /// From a type name as sqlx reports it: Postgres (`INT4`, `TIMESTAMPTZ`, `INT4[]`…),
    /// MySQL (`BIGINT UNSIGNED`, `DECIMAL`, `VARBINARY`…) or a SQLite declared/storage type
    /// (`INTEGER`, `DATETIME`, `BLOB`…).
    fn of(type_name: &str) -> Self {
        let name = type_name.to_ascii_uppercase();
        if name.ends_with("[]") {
            return Self::Text;
        }
        match name.trim_end_matches(" UNSIGNED") {
            "INT2" | "INT4" | "INT8" | "FLOAT4" | "FLOAT8" | "NUMERIC" | "OID" | "MONEY"
            | "INTEGER" | "REAL" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT"
            | "DECIMAL" | "FLOAT" | "DOUBLE" | "YEAR" => Self::Number,
            "BOOL" | "BOOLEAN" => Self::Bool,
            "DATE" | "TIME" | "TIMETZ" | "TIMESTAMP" | "TIMESTAMPTZ" | "INTERVAL" | "DATETIME" => {
                Self::Temporal
            }
            "UUID" => Self::Uuid,
            "JSON" | "JSONB" => Self::Json,
            name if is_binary(name) => Self::Binary,
            _ => Self::Text,
        }
    }
}

/// Takes an uppercase type name, as sqlx reports MySQL's, so it needs no allocation.
fn is_binary(type_name: &str) -> bool {
    matches!(
        type_name,
        "BYTEA"
            | "BLOB"
            | "BINARY"
            | "VARBINARY"
            | "TINYBLOB"
            | "MEDIUMBLOB"
            | "LONGBLOB"
            | "BIT"
            | "GEOMETRY"
    )
}

/// Runs one or more `;`-separated statements and returns the last statement's result.
/// `database` is the toolbar's database. MySQL makes it the default database for the statements,
/// as if they started with `USE`; Postgres runs them on that database's pool (another database
/// needs "Show all databases"); SQLite ignores it.
///
/// Every run that gets past the empty check is audited, failed ones included: the SQL, where it
/// ran, the outcome, the row count and the time taken. Never the result rows.
#[tauri::command]
#[specta::specta]
pub async fn run_query(
    id: String,
    sql: String,
    database: Option<String>,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<QueryOutput, CommandError> {
    require(&sql, "Query")?;
    let started = Instant::now();
    let mut details = saved.audit_details(&id).unwrap_or_default();
    details.sql = Some(sql.clone());
    if let Some(database) = database.clone().filter(|d| !d.is_empty()) {
        details.database = Some(database);
    }

    let result = execute(&id, sql, database, &connections).await;
    let elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u32::MAX);
    details.duration_ms = Some(elapsed_ms);
    match &result {
        Ok(output) => details.rows_affected = Some(output.rows_affected),
        Err(error) => details.error = Some(error.message().to_owned()),
    }
    audit.record(EventKind::QueryRun, Some(&id), details).await;
    result.map(|output| QueryOutput {
        elapsed_ms,
        ..output
    })
}

async fn execute(
    id: &str,
    sql: String,
    database: Option<String>,
    connections: &Connections,
) -> Result<QueryOutput, CommandError> {
    // Running the user's own SQL against their own database is the feature, so there is
    // nothing to sanitize here; values never get spliced into SQL by the app (the database
    // name is quoted by `use_database`).
    let open = connections.get(id)?;
    let output = match &open.pool {
        // raw_sql uses Postgres' simple query protocol, which sends every value as text.
        Pool::Postgres(_) => {
            let pool = open.pg_pool(database.as_deref()).await?;
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&pool);
            collect(results, PgQueryResult::rows_affected, pg_cell, column_type).await
        }
        // Likewise raw_sql uses MySQL's text protocol. USE goes in the same batch, so it runs on
        // the same connection without an extra round trip; collect drops its empty result.
        Pool::Mysql(pool) => {
            let sql = match database.filter(|d| !d.is_empty()) {
                Some(database) => format!("{};\n{sql}", use_database(&database)),
                None => sql,
            };
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(pool);
            collect(
                results,
                MySqlQueryResult::rows_affected,
                mysql_cell,
                column_type,
            )
            .await
        }
        Pool::Sqlite(pool) => {
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(pool);
            collect(
                results,
                SqliteQueryResult::rows_affected,
                sqlite_cell,
                sqlite_type,
            )
            .await
        }
    }
    .map_err(query_failed)?;
    Ok(output)
}

/// `USE` with the name quoted as a MySQL identifier: backticks around it, inner ones doubled.
fn use_database(name: &str) -> String {
    format!("USE `{}`", name.replace('`', "``"))
}

/// Each statement yields its rows, then one `Left` with its QueryResult. The output keeps
/// only the last statement, like most SQL clients' single result pane.
///
/// A statement that returned rows reports how many it returned, counted here: only Postgres
/// puts that in its QueryResult. MySQL's end-of-result packet says 0, and SQLite's count is
/// `sqlite3_changes()`, left over from the last INSERT/UPDATE/DELETE. Other statements report
/// the driver's count of rows changed.
async fn collect<D, R: Row>(
    mut results: impl Stream<Item = Result<Either<D, R>, sqlx::Error>> + Unpin,
    rows_affected: fn(&D) -> u64,
    cell: fn(&R, usize) -> Result<Option<String>, sqlx::Error>,
    type_name: fn(&R, usize) -> String,
) -> Result<QueryOutput, sqlx::Error> {
    let mut output = QueryOutput::default();
    // Rows the current statement has returned so far, kept or not; 0 until its first row.
    let mut row_count: u64 = 0;

    while let Some(item) = results.try_next().await? {
        match item {
            Either::Right(row) => {
                if row_count == 0 {
                    // First row of a new statement: drop the previous statement's result.
                    output = QueryOutput {
                        columns: columns_of(&row, type_name),
                        ..Default::default()
                    };
                }
                row_count += 1;
                if output.rows.len() < MAX_ROWS {
                    let mut cells = Vec::with_capacity(row.len());
                    for i in 0..row.len() {
                        cells.push(cell(&row, i)?);
                    }
                    output.rows.push(cells);
                } else {
                    output.truncated = true;
                }
            }
            Either::Left(done) => {
                output.rows_affected = if row_count > 0 {
                    row_count
                } else {
                    output = QueryOutput::default();
                    rows_affected(&done)
                };
                row_count = 0;
            }
        }
    }
    Ok(output)
}

fn columns_of<R: Row>(row: &R, type_name: fn(&R, usize) -> String) -> Vec<ResultColumn> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let type_name = type_name(row, i);
            ResultColumn {
                name: c.name().to_owned(),
                kind: ColumnKind::of(&type_name),
                type_name,
            }
        })
        .collect()
}

fn column_type<R: Row>(row: &R, i: usize) -> String {
    row.columns()[i].type_info().name().to_owned()
}

/// Same `\x…` form Postgres uses for bytea.
fn hex_text(bytes: &[u8]) -> String {
    format!("\\x{}", hex::encode(bytes))
}

/// The declared type; for an expression like `count(*)`, which has none, the first row's
/// value type instead (so it still lines up as a number).
fn sqlite_type(row: &SqliteRow, i: usize) -> String {
    let declared = row.column(i).type_info();
    if !declared.is_null() && !declared.name().is_empty() {
        return declared.name().to_owned();
    }
    match row.try_get_raw(i) {
        Ok(value) if !value.is_null() => value.type_info().name().to_owned(),
        _ => String::new(),
    }
}

/// The simple query protocol returns text, so read it as-is instead of decoding per type.
/// This handles every Postgres type, including ones sqlx has no Rust type for.
fn pg_cell(row: &PgRow, i: usize) -> Result<Option<String>, sqlx::Error> {
    row.try_get_unchecked(i)
}

/// The text protocol returns every value as text, except binary columns, which come back as
/// raw bytes. MySQL also flags `_bin`-collated text columns as binary, so a binary cell that is
/// valid UTF-8 is shown as text and only the rest as hex.
fn mysql_cell(row: &MySqlRow, i: usize) -> Result<Option<String>, sqlx::Error> {
    if !is_binary(row.column(i).type_info().name()) {
        return row.try_get_unchecked(i);
    }
    let bytes: Option<&[u8]> = row.try_get_unchecked(i)?;
    Ok(bytes.map(|b| std::str::from_utf8(b).map_or_else(|_| hex_text(b), str::to_owned)))
}

/// SQLite types each value rather than each column, so branch on the value's own type.
fn sqlite_cell(row: &SqliteRow, i: usize) -> Result<Option<String>, sqlx::Error> {
    let value = row.try_get_raw(i)?;
    if value.is_null() {
        return Ok(None);
    }
    let text = match value.type_info().name() {
        "INTEGER" => row.try_get_unchecked::<i64, _>(i)?.to_string(),
        // Debug keeps the decimal point: 1.0, not 1.
        "REAL" => format!("{:?}", row.try_get_unchecked::<f64, _>(i)?),
        "BLOB" => hex_text(row.try_get_unchecked::<&[u8], _>(i)?),
        _ => row.try_get_unchecked::<String, _>(i)?,
    };
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePool;

    async fn run(pool: &SqlitePool, sql: &'static str) -> Result<QueryOutput, sqlx::Error> {
        let results = sqlx::raw_sql(sql).fetch_many(pool);
        collect(
            results,
            SqliteQueryResult::rows_affected,
            sqlite_cell,
            sqlite_type,
        )
        .await
    }

    async fn pool() -> SqlitePool {
        SqlitePool::connect("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn returns_typed_text_cells_and_nulls() {
        let pool = pool().await;
        let out = run(
            &pool,
            "SELECT 9007199254740993 AS big, 1.0 AS real, 'hi' AS txt, x'00ff' AS bin, NULL AS empty",
        )
        .await
        .unwrap();
        let names: Vec<_> = out.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["big", "real", "txt", "bin", "empty"]);
        // Expressions have no declared type, so the first row's value types decide
        let kinds: Vec<_> = out.columns.iter().map(|c| c.kind).collect();
        use ColumnKind::*;
        assert_eq!(kinds, [Number, Number, Text, Binary, Text]);
        assert_eq!(
            out.rows,
            [[
                Some("9007199254740993".into()),
                Some("1.0".into()),
                Some("hi".into()),
                Some("\\x00ff".into()),
                None
            ]]
        );
        assert!(!out.truncated);
    }

    #[tokio::test]
    async fn keeps_only_the_last_statement() {
        let pool = pool().await;
        let out = run(
            &pool,
            "CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); SELECT 'old'; UPDATE t SET x = 3",
        )
        .await
        .unwrap();
        assert!(out.columns.is_empty() && out.rows.is_empty());
        assert_eq!(out.rows_affected, 2);

        let out = run(&pool, "UPDATE t SET x = 4; SELECT x FROM t")
            .await
            .unwrap();
        assert_eq!(out.rows, [[Some("4".into())], [Some("4".into())]]);
        assert_eq!(out.rows_affected, 2);
    }

    #[tokio::test]
    async fn counts_select_rows_not_the_drivers_change_count() {
        let pool = pool().await;
        // sqlite3_changes() still holds the INSERT's 3 while the SELECT runs.
        let out = run(
            &pool,
            "CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3); SELECT x FROM t WHERE x > 1",
        )
        .await
        .unwrap();
        assert_eq!(out.rows.len(), 2);
        assert_eq!(out.rows_affected, 2);

        // DML after a SELECT reports the DML's own count.
        let out = run(&pool, "SELECT x FROM t; DELETE FROM t WHERE x = 1")
            .await
            .unwrap();
        assert!(out.columns.is_empty() && out.rows.is_empty());
        assert_eq!(out.rows_affected, 1);
    }

    #[tokio::test]
    async fn caps_rows_and_flags_truncation() {
        let pool = pool().await;
        let out = run(
            &pool,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n",
        )
        .await
        .unwrap();
        assert_eq!(out.rows.len(), MAX_ROWS);
        assert!(out.truncated);
        assert_eq!(out.rows_affected, 1500);
    }

    /// Needs a MySQL server, so it only runs when asked:
    /// `QUERYCRAFT_MYSQL_URL=mysql://user:pass@localhost:3306 cargo test -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn counts_mysql_select_rows_after_use() {
        let url = std::env::var("QUERYCRAFT_MYSQL_URL").expect("QUERYCRAFT_MYSQL_URL");
        let pool = sqlx::mysql::MySqlPool::connect(&url).await.unwrap();
        // Same batch shape as `execute`: USE first, then the user's SELECT.
        let sql = format!(
            "{};\nWITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT i FROM n",
            use_database("mysql")
        );
        let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&pool);
        let out = collect(
            results,
            MySqlQueryResult::rows_affected,
            mysql_cell,
            column_type,
        )
        .await
        .unwrap();
        assert_eq!(out.rows.len(), 60);
        assert_eq!(out.rows_affected, 60);
    }

    #[test]
    fn quotes_the_database_name() {
        assert_eq!(use_database("shop"), "USE `shop`");
        assert_eq!(
            use_database("a`; DROP TABLE t; --"),
            "USE `a``; DROP TABLE t; --`"
        );
    }

    #[test]
    fn maps_mysql_type_names() {
        use ColumnKind::*;
        let kinds: Vec<_> = [
            "BIGINT UNSIGNED",
            "DECIMAL",
            "BOOLEAN",
            "DATETIME",
            "JSON",
            "VARBINARY",
            "VARCHAR",
            "ENUM",
        ]
        .map(ColumnKind::of)
        .into();
        assert_eq!(
            kinds,
            [Number, Number, Bool, Temporal, Json, Binary, Text, Text]
        );
    }

    #[tokio::test]
    async fn reports_sql_errors() {
        let pool = pool().await;
        assert!(run(&pool, "SELEC 1").await.is_err());
    }
}
