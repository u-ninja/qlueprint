//! Sample data: five related tables (customers, products, orders, order_items, employees) with a
//! few rows each, and a commented starter script of example queries.
//!
//! The SQL lives in `sample/*.sql`, one file per dialect (MariaDB shares MySQL's). Every script is
//! idempotent, and `load` refuses to run when a table of the same name exists without the
//! QueryCraft marker, so it never changes a table the user made.

use crate::db::{CommandError, ErrorCode, Pool};

const POSTGRES: &str = include_str!("sample/postgres.sql");
const MYSQL: &str = include_str!("sample/mysql.sql");
const SQLITE: &str = include_str!("sample/sqlite.sql");

const QUERIES_POSTGRES: &str = include_str!("sample/queries_postgres.sql");
const QUERIES_MYSQL: &str = include_str!("sample/queries_mysql.sql");
const QUERIES_SQLITE: &str = include_str!("sample/queries_sqlite.sql");

pub(crate) const TABLES: [&str; 5] = [
    "customers",
    "products",
    "orders",
    "order_items",
    "employees",
];
/// In each sample table's comment (Postgres, MySQL) or CREATE TABLE text (SQLite).
const MARKER: &str = "QueryCraft sample data";

const PG_EXISTING: &str = r"
    SELECT c.relname::text, obj_description(c.oid, 'pg_class')
    FROM pg_catalog.pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1)";
const MYSQL_EXISTING: &str = "
    SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN ('customers', 'products', 'orders', 'order_items', 'employees')";
const SQLITE_EXISTING: &str = "
    SELECT name, sql FROM sqlite_schema
    WHERE name IN ('customers', 'products', 'orders', 'order_items', 'employees')";

/// The example queries for the pool's dialect.
pub(crate) fn starter_sql(pool: &Pool) -> &'static str {
    match pool {
        Pool::Postgres(_) => QUERIES_POSTGRES,
        Pool::Mysql(_) => QUERIES_MYSQL,
        Pool::Sqlite(_) => QUERIES_SQLITE,
    }
}

fn failed(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::SampleDataFailed,
        format!(
            "Loading the sample data failed: {error}. The database and its connection are kept; retry from Local servers."
        ),
    )
}

/// Tables named like a sample table that QueryCraft didn't create.
async fn foreign_tables(pool: &Pool) -> Result<Vec<String>, CommandError> {
    let existing: Vec<(String, Option<String>)> = match pool {
        Pool::Postgres(p) => {
            let names: Vec<String> = TABLES.iter().map(|t| (*t).to_owned()).collect();
            sqlx::query_as(PG_EXISTING).bind(names).fetch_all(p).await
        }
        Pool::Mysql(p) => sqlx::query_as(MYSQL_EXISTING).fetch_all(p).await,
        Pool::Sqlite(p) => sqlx::query_as(SQLITE_EXISTING).fetch_all(p).await,
    }
    .map_err(failed)?;
    Ok(existing
        .into_iter()
        .filter(|(_, marker)| !marker.as_deref().is_some_and(|m| m.contains(MARKER)))
        .map(|(name, _)| name)
        .collect())
}

/// Creates the sample tables and rows. Safe to run again: it never duplicates a row.
pub(crate) async fn load(pool: &Pool) -> Result<(), CommandError> {
    let foreign = foreign_tables(pool).await?;
    if !foreign.is_empty() {
        return Err(CommandError::new(
            ErrorCode::SampleDataFailed,
            format!(
                "This database already has tables named {}, and QueryCraft didn’t create them. The sample data wasn’t loaded, so they are unchanged.",
                foreign.join(", ")
            ),
        ));
    }
    // Postgres and SQLite run it in one transaction, so a failure leaves nothing half-made.
    // MySQL commits each CREATE TABLE anyway; the script is idempotent, so a retry finishes it.
    match pool {
        Pool::Postgres(p) => {
            let mut tx = p.begin().await.map_err(failed)?;
            sqlx::raw_sql(POSTGRES)
                .execute(&mut *tx)
                .await
                .map_err(failed)?;
            tx.commit().await.map_err(failed)
        }
        Pool::Mysql(p) => sqlx::raw_sql(MYSQL)
            .execute(p)
            .await
            .map(drop)
            .map_err(failed),
        Pool::Sqlite(p) => {
            let mut tx = p.begin().await.map_err(failed)?;
            sqlx::raw_sql(SQLITE)
                .execute(&mut *tx)
                .await
                .map_err(failed)?;
            tx.commit().await.map_err(failed)
        }
    }
}

/// Rows in each sample table, in `TABLES` order.
#[cfg(test)]
pub(crate) async fn row_counts(pool: &Pool) -> Result<Vec<i64>, CommandError> {
    const COUNTS: [&str; 5] = [
        "SELECT COUNT(*) FROM customers",
        "SELECT COUNT(*) FROM products",
        "SELECT COUNT(*) FROM orders",
        "SELECT COUNT(*) FROM order_items",
        "SELECT COUNT(*) FROM employees",
    ];
    let mut counts = Vec::with_capacity(COUNTS.len());
    for sql in COUNTS {
        let count: i64 = match pool {
            Pool::Postgres(p) => sqlx::query_scalar(sql).fetch_one(p).await,
            Pool::Mysql(p) => sqlx::query_scalar(sql).fetch_one(p).await,
            Pool::Sqlite(p) => sqlx::query_scalar(sql).fetch_one(p).await,
        }
        .map_err(failed)?;
        counts.push(count);
    }
    Ok(counts)
}

#[cfg(test)]
pub(crate) const EXPECTED_ROWS: [i64; 5] = [10, 10, 15, 25, 5];

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn memory() -> Pool {
        Pool::Sqlite(SqlitePool::connect("sqlite::memory:").await.unwrap())
    }

    #[tokio::test]
    async fn loads_sqlite_sample_data_idempotently() {
        let pool = memory().await;
        load(&pool).await.unwrap();
        assert_eq!(row_counts(&pool).await.unwrap(), EXPECTED_ROWS);
        // Running it again changes nothing
        load(&pool).await.unwrap();
        assert_eq!(row_counts(&pool).await.unwrap(), EXPECTED_ROWS);

        let Pool::Sqlite(p) = &pool else {
            unreachable!()
        };
        // Foreign keys hold, a few NULLs exist, totals match their items
        let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL")
            .fetch_one(p)
            .await
            .unwrap();
        assert_eq!(orphans, 0);
        let nulls: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM customers WHERE city IS NULL")
            .fetch_one(p)
            .await
            .unwrap();
        assert!(nulls > 0);
        let mismatched: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM orders o WHERE abs(o.total_amount - (SELECT SUM(quantity * unit_price) FROM order_items WHERE order_id = o.id)) > 0.001",
        )
        .fetch_one(p)
        .await
        .unwrap();
        assert_eq!(mismatched, 0);
        let statuses: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT status) FROM orders")
            .fetch_one(p)
            .await
            .unwrap();
        assert_eq!(statuses, 5);
    }

    #[tokio::test]
    async fn refuses_to_touch_a_users_own_table() {
        let pool = memory().await;
        let Pool::Sqlite(p) = &pool else {
            unreachable!()
        };
        sqlx::query("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)")
            .execute(p)
            .await
            .unwrap();
        sqlx::query("INSERT INTO customers (name) VALUES ('mine')")
            .execute(p)
            .await
            .unwrap();

        let error = load(&pool).await.unwrap_err();
        assert_eq!(error.code(), ErrorCode::SampleDataFailed);
        assert!(error.message().contains("customers"));
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM customers")
            .fetch_one(p)
            .await
            .unwrap();
        assert_eq!(rows, 1);
        let others: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'products'")
                .fetch_one(p)
                .await
                .unwrap();
        assert_eq!(others, 0);
    }

    #[tokio::test]
    async fn every_starter_query_runs_on_the_sample_data() {
        let pool = memory().await;
        load(&pool).await.unwrap();
        let Pool::Sqlite(p) = &pool else {
            unreachable!()
        };
        let queries: Vec<&str> = QUERIES_SQLITE
            .split(';')
            .map(str::trim)
            .filter(|q| {
                q.lines()
                    .any(|l| !l.starts_with("--") && !l.trim().is_empty())
            })
            .collect();
        assert_eq!(queries.len(), 7);
        for query in queries {
            sqlx::query(query)
                .fetch_all(p)
                .await
                .unwrap_or_else(|e| panic!("{query}: {e}"));
        }
        // Customers with no orders: the last query
        let lonely: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)").fetch_one(p).await.unwrap();
        assert_eq!(lonely, 2);
    }
}
