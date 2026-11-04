//! Run the SQL a user typed and return a bounded, display-ready result.

use std::time::Instant;

use futures_util::{Stream, TryStreamExt};
use serde::Serialize;
use specta::Type;
use sqlx::postgres::PgRow;
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::{AssertSqlSafe, Column, Either, Row, SqlSafeStr, TypeInfo, ValueRef};
use tauri::State;

use crate::db::{CommandError, Connections, ErrorCode, Pool, require};

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
    /// From a Postgres type name as sqlx reports it (`INT4`, `TIMESTAMPTZ`, `INT4[]`…) or a
    /// SQLite declared/storage type (`INTEGER`, `DATETIME`, `BLOB`…).
    fn of(type_name: &str) -> Self {
        let name = type_name.to_ascii_uppercase();
        if name.ends_with("[]") {
            return Self::Text;
        }
        match name.as_str() {
            "INT2" | "INT4" | "INT8" | "FLOAT4" | "FLOAT8" | "NUMERIC" | "OID" | "MONEY"
            | "INTEGER" | "REAL" => Self::Number,
            "BOOL" | "BOOLEAN" => Self::Bool,
            "DATE" | "TIME" | "TIMETZ" | "TIMESTAMP" | "TIMESTAMPTZ" | "INTERVAL" | "DATETIME" => {
                Self::Temporal
            }
            "UUID" => Self::Uuid,
            "JSON" | "JSONB" => Self::Json,
            "BYTEA" | "BLOB" => Self::Binary,
            _ => Self::Text,
        }
    }
}

/// Runs one or more `;`-separated statements and returns the last statement's result.
#[tauri::command]
#[specta::specta]
pub async fn run_query(
    id: String,
    sql: String,
    connections: State<'_, Connections>,
) -> Result<QueryOutput, CommandError> {
    require(&sql, "Query")?;
    // Running the user's own SQL against their own database is the feature, so there is
    // nothing to sanitize here; values never get spliced into SQL by the app.
    let sql = AssertSqlSafe(sql);
    let started = Instant::now();

    let mut output = match connections.get(&id)? {
        // raw_sql uses Postgres' simple query protocol, which sends every value as text.
        Pool::Postgres(pool) => {
            let results = sqlx::raw_sql(sql).fetch_many(&pool);
            collect(
                results.map_ok(|r| r.map_left(|done| done.rows_affected())),
                pg_cell,
                pg_type,
            )
            .await
        }
        Pool::Sqlite(pool) => collect(sqlite_results(&pool, sql), sqlite_cell, sqlite_type).await,
    }
    .map_err(|e| CommandError::new(ErrorCode::QueryFailed, e.to_string()))?;

    output.elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u32::MAX);
    Ok(output)
}

/// The driver's result stream with each statement's QueryResult reduced to its row count.
fn sqlite_results<'a>(
    pool: &'a SqlitePool,
    sql: impl SqlSafeStr,
) -> impl Stream<Item = Result<Either<u64, SqliteRow>, sqlx::Error>> + Unpin + 'a {
    sqlx::raw_sql(sql)
        .fetch_many(pool)
        .map_ok(|r| r.map_left(|done| done.rows_affected()))
}

/// Each statement yields its rows, then one `Left` with its row count. The output keeps
/// only the last statement, like most SQL clients' single result pane.
async fn collect<R: Row>(
    mut results: impl Stream<Item = Result<Either<u64, R>, sqlx::Error>> + Unpin,
    cell: fn(&R, usize) -> Result<Option<String>, sqlx::Error>,
    type_name: fn(&R, usize) -> String,
) -> Result<QueryOutput, sqlx::Error> {
    let mut output = QueryOutput::default();
    let mut statement_has_rows = false;

    while let Some(item) = results.try_next().await? {
        match item {
            Either::Right(row) => {
                if !statement_has_rows {
                    // First row of a new statement: drop the previous statement's result.
                    statement_has_rows = true;
                    output = QueryOutput {
                        columns: columns_of(&row, type_name),
                        ..Default::default()
                    };
                }
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
            Either::Left(rows_affected) => {
                if !statement_has_rows {
                    output = QueryOutput::default();
                }
                output.rows_affected = rows_affected;
                statement_has_rows = false;
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

fn pg_type(row: &PgRow, i: usize) -> String {
    row.column(i).type_info().name().to_owned()
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
        // Same `\x…` form Postgres uses for bytea.
        "BLOB" => format!("\\x{}", hex::encode(row.try_get_unchecked::<&[u8], _>(i)?)),
        _ => row.try_get_unchecked::<String, _>(i)?,
    };
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn run(pool: &SqlitePool, sql: &'static str) -> Result<QueryOutput, sqlx::Error> {
        collect(sqlite_results(pool, sql), sqlite_cell, sqlite_type).await
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
    }

    #[tokio::test]
    async fn reports_sql_errors() {
        let pool = pool().await;
        assert!(run(&pool, "SELEC 1").await.is_err());
    }
}
