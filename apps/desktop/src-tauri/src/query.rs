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

use crate::audit::{Audit, Details, EventKind};
use crate::db::{CommandError, Connections, ErrorCode, Pool, query_failed, require};
use crate::saved::Saved;

/// Rows kept per result. The rest are still read (to count them) but not stored,
/// so a large SELECT can't exhaust memory in Rust or in the UI.
pub const MAX_ROWS: usize = 1000;

/// Rows kept when the user asks for all of them ("Load all rows"). Still a cap, so one huge
/// SELECT can't exhaust memory.
// shortcut: everything held in memory at once; page through a server-side cursor if people need millions
pub const ALL_ROWS: usize = 100_000;

#[derive(Debug, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    pub(crate) columns: Vec<ResultColumn>,
    /// Every cell as text, `null` for SQL NULL. Text keeps big integers, decimals and
    /// timestamps exact; a JS number would round anything past 2^53.
    pub(crate) rows: Vec<Vec<Option<String>>>,
    /// More rows came back than were kept (`MAX_ROWS`, or `ALL_ROWS` when all were asked for).
    pub(crate) truncated: bool,
    /// For a SELECT, the total row count; otherwise rows inserted/updated/deleted.
    #[specta(type = specta_typescript::Number)]
    pub(crate) rows_affected: u64,
    pub(crate) elapsed_ms: u32,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub(crate) name: String,
    /// The database's own type name, e.g. `INT4` or `TEXT`. Empty when SQLite has none.
    pub(crate) type_name: String,
    /// How the UI should align and size the column.
    pub(crate) kind: ColumnKind,
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

/// Runs one or more `;`-separated statements and returns the last statement's result (SQL Server:
/// the last result set, see `mssql::run`). `database` is the toolbar's database. MySQL makes it
/// the default database for the statements, as if they started with `USE`; Postgres and SQL Server
/// run them on that database's pool (another database needs "Show all databases"); SQLite ignores it.
///
/// Every run that gets past the empty check is audited, failed ones included: the SQL, where it
/// ran, the outcome, the row count and the time taken. Never the result rows.
#[tauri::command]
#[specta::specta]
pub async fn run_query(
    id: String,
    sql: String,
    database: Option<String>,
    all_rows: bool,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<QueryOutput, CommandError> {
    require(&sql, "Query")?;
    let keep = if all_rows { ALL_ROWS } else { MAX_ROWS };
    run_audited(
        &id,
        sql,
        non_empty(database),
        keep,
        &connections,
        &saved,
        &audit,
    )
    .await
}

/// Runs `sql` on connection `id` and audits it as a query run, failed or not. `database` is
/// already `non_empty`.
pub(crate) async fn run_audited(
    id: &str,
    sql: String,
    database: Option<String>,
    keep: usize,
    connections: &Connections,
    saved: &Saved,
    audit: &Audit,
) -> Result<QueryOutput, CommandError> {
    let started = Instant::now();
    let details = audit_base(saved, id, database.as_deref());
    let result = execute(id, sql.clone(), database, keep, connections).await;
    let elapsed_ms = elapsed_ms(started);
    let outcome = result.as_ref().map(|output| output.rows_affected);
    let details = run_details(
        details,
        sql,
        elapsed_ms,
        outcome.map_err(CommandError::message),
    );
    audit.record(EventKind::QueryRun, Some(id), details).await;
    result.map(|output| QueryOutput {
        elapsed_ms,
        ..output
    })
}

/// Milliseconds since `started`, for a result's and an audit entry's timing.
pub(crate) fn elapsed_ms(started: Instant) -> u32 {
    started.elapsed().as_millis().try_into().unwrap_or(u32::MAX)
}

/// A database name from the UI, where "" means the connection's own.
pub(crate) fn non_empty(database: Option<String>) -> Option<String> {
    database.filter(|d| !d.is_empty())
}

/// An audit entry for a statement on connection `id`: where it ran, with `database` when the
/// toolbar picked one instead of the connection's own.
pub(crate) fn audit_base(saved: &Saved, id: &str, database: Option<&str>) -> Details {
    let mut details = saved.audit_details(id).unwrap_or_default();
    if let Some(database) = database {
        details.database = Some(database.to_owned());
    }
    details
}

/// `base` completed for one statement that ran: its SQL, time taken, and the rows it returned or
/// changed, or why it failed.
pub(crate) fn run_details(
    mut base: Details,
    sql: String,
    duration_ms: u32,
    outcome: Result<u64, &str>,
) -> Details {
    base.sql = Some(sql);
    base.duration_ms = Some(duration_ms);
    match outcome {
        Ok(rows) => base.rows_affected = Some(rows),
        Err(error) => base.error = Some(error.to_owned()),
    }
    base
}

/// `database` is already `non_empty`.
async fn execute(
    id: &str,
    sql: String,
    database: Option<String>,
    keep: usize,
    connections: &Connections,
) -> Result<QueryOutput, CommandError> {
    // Running the user's own SQL against their own database is the feature, so there is
    // nothing to sanitize here; values never get spliced into SQL by the app (the database
    // name is quoted by `use_database`).
    let open = connections.get(id)?;
    let output = match open.pool_for(database.as_deref()).await? {
        Pool::Mssql(pool) => return crate::mssql::run(&pool, &sql, keep).await,
        // raw_sql uses Postgres' simple query protocol, which sends every value as text.
        Pool::Postgres(pool) => {
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&pool);
            collect(
                results,
                keep,
                PgQueryResult::rows_affected,
                pg_cell,
                column_type,
            )
            .await
        }
        // Likewise raw_sql uses MySQL's text protocol. USE goes in the same batch, so it runs on
        // the same connection without an extra round trip; collect drops its empty result.
        Pool::Mysql(pool) => {
            let sql = match database {
                Some(database) => format!("{};\n{sql}", use_database(&database)),
                None => sql,
            };
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&pool);
            collect(
                results,
                keep,
                MySqlQueryResult::rows_affected,
                mysql_cell,
                column_type,
            )
            .await
        }
        Pool::Sqlite(pool) => {
            let results = sqlx::raw_sql(AssertSqlSafe(sql)).fetch_many(&pool);
            collect(
                results,
                keep,
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

/// One statement of `apply_edits` as it ran, for the audit log.
struct Ran {
    sql: String,
    /// Rows changed, or why it failed
    outcome: Result<u64, String>,
    duration_ms: u32,
}

impl Ran {
    fn new(sql: &str, result: &Result<u64, CommandError>, started: Instant) -> Self {
        Self {
            sql: sql.to_owned(),
            outcome: result.as_ref().copied().map_err(|e| e.message().to_owned()),
            duration_ms: elapsed_ms(started),
        }
    }
}

/// Saves the grid's edits: `UPDATE`s that each change one row by its primary key, all in one
/// transaction. A statement that matches no row (or more than one) rolls everything back, so a
/// row someone else deleted or re-keyed can't leave half the edits saved.
///
/// `database` works as in `run_query`. Each statement is audited like a query run, a rolled-back
/// one with why.
#[tauri::command]
#[specta::specta]
pub async fn apply_edits(
    id: String,
    database: Option<String>,
    statements: Vec<String>,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<(), CommandError> {
    if statements.is_empty() {
        return Ok(());
    }
    let open = connections.get(&id)?;
    let database = non_empty(database);
    let mut ran = Vec::with_capacity(statements.len());
    let result = match open.pool_for(database.as_deref()).await? {
        Pool::Postgres(pool) => {
            in_transaction(
                &pool,
                None,
                &statements,
                PgQueryResult::rows_affected,
                &mut ran,
            )
            .await
        }
        Pool::Mysql(pool) => {
            let prelude = database.as_deref().map(use_database);
            in_transaction(
                &pool,
                prelude,
                &statements,
                MySqlQueryResult::rows_affected,
                &mut ran,
            )
            .await
        }
        Pool::Mssql(pool) => mssql_transaction(&pool, &statements, &mut ran).await,
        Pool::Sqlite(pool) => {
            in_transaction(
                &pool,
                None,
                &statements,
                SqliteQueryResult::rows_affected,
                &mut ran,
            )
            .await
        }
    };

    let base = audit_base(&saved, &id, database.as_deref());
    let rolled_back = result
        .as_ref()
        .err()
        .map(|e| format!("Rolled back: {}", e.message()));
    let entries: Vec<Details> = ran
        .into_iter()
        .map(|r| {
            let outcome = r.outcome.as_ref().copied().map_err(String::as_str);
            let mut details = run_details(base.clone(), r.sql, r.duration_ms, outcome);
            // A statement that ran fine keeps its count, and says it was undone with the rest
            details.error = details.error.or_else(|| rolled_back.clone());
            details
        })
        .collect();
    audit
        .record_all(EventKind::QueryRun, Some(&id), entries)
        .await;
    result
}

/// Runs `statements` in one transaction, after `prelude` (MySQL's `USE`) on the same connection.
/// Each must change exactly one row; otherwise, or on any error, dropping the transaction rolls
/// it back. `ran` gets every statement that was tried.
async fn in_transaction<DB: sqlx::Database>(
    pool: &sqlx::Pool<DB>,
    prelude: Option<String>,
    statements: &[String],
    rows_affected: fn(&DB::QueryResult) -> u64,
    ran: &mut Vec<Ran>,
) -> Result<(), CommandError>
where
    for<'c> &'c mut DB::Connection: sqlx::Executor<'c, Database = DB>,
{
    let mut tx = pool.begin().await.map_err(query_failed)?;
    if let Some(sql) = prelude {
        sqlx::raw_sql(AssertSqlSafe(sql))
            .execute(&mut *tx)
            .await
            .map_err(query_failed)?;
    }
    for sql in statements {
        let started = Instant::now();
        let result = sqlx::raw_sql(AssertSqlSafe(sql.as_str()))
            .execute(&mut *tx)
            .await;
        let result = result.map(|r| rows_affected(&r)).map_err(query_failed);
        ran.push(Ran::new(sql, &result, started));
        one_row(sql, result?)?;
    }
    tx.commit().await.map_err(query_failed)
}

/// An edit must change exactly the one row it names.
fn one_row(sql: &str, rows: u64) -> Result<(), CommandError> {
    if rows == 1 {
        return Ok(());
    }
    // The UI writes `… WHERE <primary key>`: name the row by it
    let row = sql.rsplit_once(" WHERE ").map_or(sql, |(_, w)| w);
    let message = if rows == 0 {
        format!("Row {row} changed or no longer exists — nothing was saved.")
    } else {
        format!("{rows} rows match {row}, not one — nothing was saved.")
    };
    Err(CommandError::new(ErrorCode::QueryFailed, message))
}

/// `in_transaction` for SQL Server, on one pooled connection: BEGIN TRAN, each statement with the
/// server's `@@ROWCOUNT` for it, then COMMIT, or ROLLBACK at the first failure.
async fn mssql_transaction(
    pool: &crate::mssql::MssqlPool,
    statements: &[String],
    ran: &mut Vec<Ran>,
) -> Result<(), CommandError> {
    use crate::mssql::{execute_counted, query_failed};
    let mut conn = pool.get().await?;
    let client = conn.client();
    client
        .simple_query("BEGIN TRANSACTION")
        .await
        .map_err(query_failed)?
        .into_results()
        .await
        .map_err(query_failed)?;
    let mut result = Ok(());
    for sql in statements {
        let started = Instant::now();
        let outcome = execute_counted(client, sql).await.map_err(query_failed);
        ran.push(Ran::new(sql, &outcome, started));
        result = outcome.and_then(|rows| one_row(sql, rows));
        if result.is_err() {
            break;
        }
    }
    // An error may already have ended the transaction (XACT_ABORT), hence the check
    let end = if result.is_ok() {
        "COMMIT TRANSACTION"
    } else {
        "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"
    };
    let ended = async { client.simple_query(end).await?.into_results().await }.await;
    if ended.is_err() {
        conn.discard();
    }
    result?;
    ended.map(drop).map_err(query_failed)
}

/// `USE` with the name quoted as a MySQL identifier: backticks around it, inner ones doubled.
fn use_database(name: &str) -> String {
    format!("USE {}", crate::inspect::quote_ident(name, '`'))
}

/// Each statement yields its rows, then one `Left` with its QueryResult. The output keeps
/// only the last statement, like most SQL clients' single result pane.
///
/// A statement that returned rows reports how many it returned, counted here: only Postgres
/// puts that in its QueryResult. MySQL's end-of-result packet says 0, and SQLite's count is
/// `sqlite3_changes()`, left over from the last INSERT/UPDATE/DELETE. Other statements report
/// the driver's count of rows changed.
pub(crate) async fn collect<D, R: Row>(
    mut results: impl Stream<Item = Result<Either<D, R>, sqlx::Error>> + Unpin,
    keep: usize,
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
                if output.rows.len() < keep {
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
pub(crate) fn hex_text(bytes: &[u8]) -> String {
    format!("\\x{}", hex::encode(bytes))
}

/// The declared type; for an expression like `count(*)`, which has none, the first row's
/// value type instead (so it still lines up as a number).
pub(crate) fn sqlite_type(row: &SqliteRow, i: usize) -> String {
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
pub(crate) fn sqlite_cell(row: &SqliteRow, i: usize) -> Result<Option<String>, sqlx::Error> {
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
        run_keeping(pool, sql, MAX_ROWS).await
    }

    async fn run_keeping(
        pool: &SqlitePool,
        sql: &'static str,
        keep: usize,
    ) -> Result<QueryOutput, sqlx::Error> {
        let results = sqlx::raw_sql(sql).fetch_many(pool);
        collect(
            results,
            keep,
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

    #[tokio::test]
    async fn keeps_every_row_when_all_are_asked_for() {
        let pool = pool().await;
        let out = run_keeping(
            &pool,
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n",
            ALL_ROWS,
        )
        .await
        .unwrap();
        assert_eq!(out.rows.len(), 1500);
        assert!(!out.truncated);
        assert_eq!(out.rows[1499], [Some("1500".into())]);
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
            MAX_ROWS,
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

    async fn save(pool: &SqlitePool, statements: &[&str]) -> (Result<(), CommandError>, usize) {
        let statements: Vec<String> = statements.iter().map(|s| s.to_string()).collect();
        let mut ran = Vec::new();
        let result = in_transaction(
            pool,
            None,
            &statements,
            SqliteQueryResult::rows_affected,
            &mut ran,
        )
        .await;
        (result, ran.len())
    }

    #[tokio::test]
    async fn saves_edits_all_or_nothing() {
        // One connection: every connection to sqlite::memory: is its own empty database
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        run(
            &pool,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b')",
        )
        .await
        .unwrap();
        let names = "SELECT name FROM t ORDER BY id";

        // The second matches no row: the first is rolled back with it
        let (result, ran) = save(
            &pool,
            &[
                "UPDATE t SET name = 'x' WHERE \"id\" = 1",
                "UPDATE t SET name = 'y' WHERE \"id\" = 99",
            ],
        )
        .await;
        assert_eq!(
            result.unwrap_err().message(),
            "Row \"id\" = 99 changed or no longer exists — nothing was saved."
        );
        assert_eq!(ran, 2);
        assert_eq!(
            run(&pool, names).await.unwrap().rows,
            [[Some("a".into())], [Some("b".into())]]
        );

        let (result, _) = save(
            &pool,
            &[
                "UPDATE t SET name = 'x' WHERE \"id\" = 1",
                "UPDATE t SET name = NULL WHERE \"id\" = 2",
            ],
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(
            run(&pool, names).await.unwrap().rows,
            [[Some("x".into())], [None]]
        );
    }

    #[tokio::test]
    async fn reports_sql_errors() {
        let pool = pool().await;
        assert!(run(&pool, "SELEC 1").await.is_err());
    }
}
