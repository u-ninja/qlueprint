//! The local audit log: an append-only, hash-chained record of what the app did with the user's
//! databases, in `<app data>/audit.db` next to `connections.json`.
//!
//! Each entry is written by the Rust command it describes, never by the UI, so the UI can't skip
//! one. Entries never hold a password (`redact` masks the ones that can turn up in recorded text)
//! or a result value: a query entry has the SQL, its outcome and counts, never rows.
//!
//! Tamper evidence: every row stores `prev_hash` and `hash = SHA-256(prev_hash || canonical)`,
//! where `canonical` is the entry (id, time, event, connection, details) as compact JSON with
//! keys sorted by their UTF-8 bytes. The first row's `prev_hash` is 64 zeros. Editing, inserting
//! or deleting a row breaks the chain from there on, and `verify_audit_log` reports the first
//! entry that doesn't match. The JSON export carries the same fields, so it can be checked
//! outside the app too. Triggers refuse UPDATE and DELETE, and the app has no command for either.
//! shortcut: rows cut off the end leave a shorter chain that still verifies; anchor the newest
//! hash outside the file (OS credential store, a signed export) to catch that.
//!
//! Failure policy: a failed audit write never fails or blocks the action it describes. Refusing
//! to run a query because the log is unwritable (a full disk, a locked file) would take the
//! app away from the user over a side record. So `record` logs the error with `eprintln!` and
//! counts it, and the audit screen shows the count, so a gap in the log is visible, not silent.

use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use specta::Type;
use sqlx::sqlite::{
    Sqlite, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions,
    SqliteSynchronous,
};
use sqlx::{QueryBuilder, Row};
use tauri::State;

use crate::db::{CommandError, ErrorCode};

const FILE: &str = "audit.db";
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const PAGE_SIZE: u32 = 200;
const MAX_PAGE_SIZE: u32 = 1000;

// `id` is assigned by `append` (last id + 1), not AUTOINCREMENT, because it is part of the hash.
// `at` is Unix time in milliseconds, so UTC by definition. `details` is canonical JSON.
const SCHEMA: &str = r"
    CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        connection_id TEXT,
        details TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);
    CREATE INDEX IF NOT EXISTS audit_events_event ON audit_events (event);
    CREATE INDEX IF NOT EXISTS audit_events_connection ON audit_events (connection_id);
    CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'The audit log is append-only'); END;";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    ConnectionSaved,
    ConnectionOpened,
    ConnectionFailed,
    ConnectionClosed,
    ConnectionForgotten,
    /// A password went into the OS credential store.
    CredentialStored,
    /// A password was removed from the OS credential store.
    CredentialDeleted,
    QueryRun,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ConnectionSaved => "connection_saved",
            Self::ConnectionOpened => "connection_opened",
            Self::ConnectionFailed => "connection_failed",
            Self::ConnectionClosed => "connection_closed",
            Self::ConnectionForgotten => "connection_forgotten",
            Self::CredentialStored => "credential_stored",
            Self::CredentialDeleted => "credential_deleted",
            Self::QueryRun => "query_run",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Postgres,
    Mysql,
    Sqlite,
}

/// What an entry records beyond its type and connection, stored as the `details` JSON. Empty
/// fields are left out. Never a password, never a result value.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<Engine>,
    /// `user@host:port` for a server, the file path for SQLite.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The database a query ran in (the toolbar's), or the one a connection was saved with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Number>)]
    pub rows_affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    /// Set when the action failed; an entry without one succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Details {
    /// The same details for an action that failed with `error`.
    pub(crate) fn with_error(self, error: &CommandError) -> Self {
        Self {
            error: Some(error.message().to_owned()),
            ..self
        }
    }

    /// Masks passwords in every text field, wherever they came from.
    fn redacted(mut self) -> Self {
        for field in [
            &mut self.label,
            &mut self.target,
            &mut self.database,
            &mut self.sql,
            &mut self.error,
        ]
        .into_iter()
        .flatten()
        {
            *field = redact(field);
        }
        self
    }
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    #[specta(type = specta_typescript::Number)]
    id: i64,
    /// Unix time in milliseconds (UTC).
    #[specta(type = specta_typescript::Number)]
    at: i64,
    event: EventKind,
    connection_id: Option<String>,
    details: Details,
    hash: String,
}

/// Every field narrows the list; `null` means no filter.
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilter {
    event: Option<EventKind>,
    connection_id: Option<String>,
    /// Matched, case-insensitively for ASCII, against every value in `details` (SQL, label,
    /// error, target, database).
    search: Option<String>,
    /// Unix ms, inclusive.
    #[specta(type = Option<specta_typescript::Number>)]
    from: Option<i64>,
    /// Unix ms, exclusive.
    #[specta(type = Option<specta_typescript::Number>)]
    to: Option<i64>,
    /// The previous page's `nextCursor`: entries older than it.
    #[specta(type = Option<specta_typescript::Number>)]
    before: Option<i64>,
    /// Defaults to 200, at most 1000.
    limit: Option<u32>,
}

/// One page, newest first.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    events: Vec<AuditEvent>,
    /// Pass as `before` to get the next (older) page; `null` on the last one.
    #[specta(type = Option<specta_typescript::Number>)]
    next_cursor: Option<i64>,
    /// Entries that couldn't be written since the app started (see the failure policy).
    failed_writes: u32,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub(crate) intact: bool,
    /// Entries checked: all of them when intact, otherwise the ones before the break.
    #[specta(type = specta_typescript::Number)]
    pub(crate) entries: u64,
    /// The first entry whose hash or link to the previous entry doesn't match.
    #[specta(type = Option<specta_typescript::Number>)]
    broken_id: Option<i64>,
}

#[derive(Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

pub struct Audit {
    /// The error when the file couldn't be opened; every write then counts as failed.
    pool: Result<SqlitePool, String>,
    failed_writes: AtomicU32,
}

fn audit_failed(error: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::AuditFailed,
        format!("Couldn't read the audit log: {error}"),
    )
}

fn now_ms() -> i64 {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    ms.try_into().unwrap_or(i64::MAX)
}

/// JSON with object keys sorted and no whitespace, so the same entry always hashes the same,
/// whatever order serde_json keeps keys in.
fn canonical(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, key) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&Value::from(key.as_str()).to_string());
                    out.push(':');
                    write(&map[key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            scalar => out.push_str(&scalar.to_string()),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// `SHA-256(prev_hash || canonical entry)` as hex.
fn chain_hash(
    prev_hash: &str,
    id: i64,
    at: i64,
    event: &str,
    connection_id: Option<&str>,
    details: &Value,
) -> String {
    let entry = json!({
        "id": id,
        "at": at,
        "event": event,
        "connectionId": connection_id,
        "details": details,
    });
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update(canonical(&entry).as_bytes());
    hex::encode(hasher.finalize())
}

/// `%` and `_` match themselves; `\` is the ESCAPE character.
fn like_pattern(text: &str) -> String {
    let escaped = text
        .replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_");
    format!("%{escaped}%")
}

impl Audit {
    /// Opens (creating if needed) `<dir>/audit.db`. Never fails: an unopenable file is kept as
    /// an error so the app still starts, and every write then counts as failed.
    pub async fn open(dir: &Path) -> Self {
        let pool = Self::connect(dir).await.map_err(|error| {
            eprintln!("audit: couldn't open {}: {error}", dir.join(FILE).display());
            error.to_string()
        });
        Self {
            pool,
            failed_writes: AtomicU32::new(0),
        }
    }

    async fn connect(dir: &Path) -> Result<SqlitePool, sqlx::Error> {
        std::fs::create_dir_all(dir)?;
        // WAL lets the audit screen read while a command appends; FULL syncs every commit, so
        // an entry that was written survives a power cut.
        let options = SqliteConnectOptions::new()
            .filename(dir.join(FILE))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await?;
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        Ok(pool)
    }

    fn pool(&self) -> Result<&SqlitePool, CommandError> {
        self.pool.as_ref().map_err(audit_failed)
    }

    /// Appends an entry. Never fails the caller: see the failure policy at the top.
    pub(crate) async fn record(
        &self,
        event: EventKind,
        connection_id: Option<&str>,
        details: Details,
    ) {
        let details = serde_json::to_value(details.redacted()).expect("details serialize");
        let result = match &self.pool {
            Ok(pool) => Self::append(pool, event, connection_id, &details, now_ms())
                .await
                .map_err(|e| e.to_string()),
            Err(error) => Err(error.clone()),
        };
        if let Err(error) = result {
            self.failed_writes.fetch_add(1, Ordering::Relaxed);
            eprintln!("audit: couldn't record {}: {error}", event.as_str());
        }
    }

    async fn append(
        pool: &SqlitePool,
        event: EventKind,
        connection_id: Option<&str>,
        details: &Value,
        at: i64,
    ) -> Result<(), sqlx::Error> {
        // IMMEDIATE takes the write lock before reading the last hash, so two appends (two
        // commands, or two app windows) can't both chain onto the same entry.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let last: Option<(i64, String)> =
            sqlx::query_as("SELECT id, hash FROM audit_events ORDER BY id DESC LIMIT 1")
                .fetch_optional(&mut *tx)
                .await?;
        let (id, prev_hash) = last.map_or((1, GENESIS.to_owned()), |(id, hash)| (id + 1, hash));
        let hash = chain_hash(&prev_hash, id, at, event.as_str(), connection_id, details);
        sqlx::query(
            "INSERT INTO audit_events (id, at, event, connection_id, details, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(at)
        .bind(event.as_str())
        .bind(connection_id)
        .bind(canonical(details))
        .bind(&prev_hash)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    pub(crate) async fn list(&self, filter: AuditFilter) -> Result<AuditPage, CommandError> {
        let limit = filter.limit.unwrap_or(PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT id, at, event, connection_id, details, hash FROM audit_events WHERE 1 = 1",
        );
        if let Some(event) = filter.event {
            query.push(" AND event = ").push_bind(event.as_str());
        }
        if let Some(id) = filter.connection_id {
            query.push(" AND connection_id = ").push_bind(id);
        }
        if let Some(search) = filter.search.filter(|s| !s.trim().is_empty()) {
            // Values only: searching "sql" shouldn't match every query by its key name
            query
                .push(" AND EXISTS (SELECT 1 FROM json_each(details) WHERE value LIKE ")
                .push_bind(like_pattern(search.trim()))
                .push(r" ESCAPE '\')");
        }
        if let Some(from) = filter.from {
            query.push(" AND at >= ").push_bind(from);
        }
        if let Some(to) = filter.to {
            query.push(" AND at < ").push_bind(to);
        }
        if let Some(before) = filter.before {
            query.push(" AND id < ").push_bind(before);
        }
        // One extra row says whether there is another page
        query
            .push(" ORDER BY id DESC LIMIT ")
            .push_bind(i64::from(limit) + 1);

        let rows = query
            .build()
            .fetch_all(self.pool()?)
            .await
            .map_err(audit_failed)?;
        let has_more = rows.len() > limit as usize;
        let mut events = Vec::with_capacity(rows.len().min(limit as usize));
        for row in rows.iter().take(limit as usize) {
            let event: String = row.get(2);
            let details: String = row.get(4);
            events.push(AuditEvent {
                id: row.get(0),
                at: row.get(1),
                event: serde_json::from_value(Value::String(event)).map_err(audit_failed)?,
                connection_id: row.get(3),
                details: serde_json::from_str(&details).map_err(audit_failed)?,
                hash: row.get(5),
            });
        }
        Ok(AuditPage {
            next_cursor: has_more.then(|| events.last().map(|e| e.id)).flatten(),
            events,
            failed_writes: self.failed_writes.load(Ordering::Relaxed),
        })
    }

    /// Walks the chain oldest first, streaming, so a long log isn't loaded into memory.
    pub(crate) async fn verify(&self) -> Result<Verification, CommandError> {
        let mut rows = sqlx::query_as::<_, (i64, i64, String, Option<String>, String, String, String)>(
            "SELECT id, at, event, connection_id, details, prev_hash, hash FROM audit_events ORDER BY id",
        )
        .fetch(self.pool()?);
        let mut expected_prev = GENESIS.to_owned();
        let mut entries = 0;
        while let Some((id, at, event, connection_id, details, prev_hash, hash)) =
            rows.try_next().await.map_err(audit_failed)?
        {
            // Details that aren't JSON any more can only come from editing the file
            let recomputed = serde_json::from_str(&details).ok().map(|details| {
                chain_hash(
                    &prev_hash,
                    id,
                    at,
                    &event,
                    connection_id.as_deref(),
                    &details,
                )
            });
            if prev_hash != expected_prev || recomputed.as_deref() != Some(hash.as_str()) {
                return Ok(Verification {
                    intact: false,
                    entries,
                    broken_id: Some(id),
                });
            }
            expected_prev = hash;
            entries += 1;
        }
        Ok(Verification {
            intact: true,
            entries,
            broken_id: None,
        })
    }

    /// The whole log, oldest first, with each entry's hashes. JSON keeps `details` as an object
    /// and the raw `atMs`, so the chain can be re-checked from the file; CSV flattens it for a
    /// spreadsheet.
    pub(crate) async fn export(&self, format: ExportFormat) -> Result<String, CommandError> {
        let rows = sqlx::query_as::<
            _,
            (
                i64,
                i64,
                String,
                String,
                Option<String>,
                String,
                String,
                String,
            ),
        >(
            "SELECT id, at, strftime('%Y-%m-%dT%H:%M:%fZ', at / 1000.0, 'unixepoch'), event,
                    connection_id, details, prev_hash, hash
             FROM audit_events ORDER BY id",
        )
        .fetch_all(self.pool()?)
        .await
        .map_err(audit_failed)?;

        match format {
            ExportFormat::Json => {
                let mut entries = Vec::with_capacity(rows.len());
                for (id, at_ms, at, event, connection_id, details, prev_hash, hash) in rows {
                    let details: Value = serde_json::from_str(&details).map_err(audit_failed)?;
                    entries.push(json!({
                        "id": id,
                        "at": at,
                        "atMs": at_ms,
                        "event": event,
                        "connectionId": connection_id,
                        "details": details,
                        "prevHash": prev_hash,
                        "hash": hash,
                    }));
                }
                Ok(serde_json::to_string_pretty(&entries).expect("JSON values serialize"))
            }
            ExportFormat::Csv => {
                let mut out = String::from(
                    "id,time_utc,event,connection_id,label,engine,target,database,sql,rows_affected,duration_ms,error,prev_hash,hash\r\n",
                );
                for (id, _, at, event, connection_id, details, prev_hash, hash) in rows {
                    let details: Value = serde_json::from_str(&details).map_err(audit_failed)?;
                    let detail = |key: &str| match &details[key] {
                        Value::Null => String::new(),
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    let fields = [
                        id.to_string(),
                        at,
                        event,
                        connection_id.unwrap_or_default(),
                        detail("label"),
                        detail("engine"),
                        detail("target"),
                        detail("database"),
                        detail("sql"),
                        detail("rowsAffected"),
                        detail("durationMs"),
                        detail("error"),
                        prev_hash,
                        hash,
                    ];
                    let line: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
                    out.push_str(&line.join(","));
                    out.push_str("\r\n");
                }
                Ok(out)
            }
        }
    }
}

/// RFC 4180 quoting. A cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR)
/// gets a leading `'`, so opening the export can't execute SQL text as a formula.
fn csv_field(value: &str) -> String {
    let guarded = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

/// Masks passwords that can turn up in recorded text: the password in a URL's user info
/// (`postgres://user:secret@host`), `password=secret` style pairs (libpq, ODBC, JDBC), and the
/// quoted literal after SQL's `PASSWORD` or `IDENTIFIED BY`. Best effort: SQL has too many ways
/// to carry a secret to catch them all.
pub(crate) fn redact(text: &str) -> String {
    const MASK: &str = "***";
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let lower = lower.as_bytes();
    let mut masks: Vec<(usize, usize)> = Vec::new();

    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let skip_space = |mut i: usize| {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        i
    };
    // The end of a quoted literal starting at `start` (a doubled quote is an escaped one)
    let quoted_end = |start: usize| {
        let quote = bytes[start];
        let mut i = start + 1;
        while i < bytes.len() {
            if bytes[i] == quote {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                    continue;
                }
                return i;
            }
            i += 1;
        }
        bytes.len()
    };
    let word_at = |i: usize, word: &[u8]| {
        lower[i..].starts_with(word)
            && (i == 0 || !is_word(bytes[i - 1]))
            && bytes.get(i + word.len()).is_none_or(|&b| !is_word(b))
    };
    // A quoted literal at `i`, or with `bare` an unquoted value up to a separator
    let mask_value = |i: usize, bare: bool, masks: &mut Vec<(usize, usize)>| {
        if i >= bytes.len() {
            return;
        }
        if matches!(bytes[i], b'\'' | b'"') {
            let end = quoted_end(i);
            if end > i + 1 {
                masks.push((i + 1, end));
            }
        } else if bare {
            let end = (i..bytes.len())
                .find(|&j| bytes[j].is_ascii_whitespace() || b";&,'\"".contains(&bytes[j]))
                .unwrap_or(bytes.len());
            if end > i {
                masks.push((i, end));
            }
        }
    };

    let mut i = 0;
    while i < bytes.len() {
        if lower[i..].starts_with(b"://") {
            // user:password@ before the host
            let start = i + 3;
            let end = (start..bytes.len())
                .find(|&j| b"@/?# \t\r\n'\"".contains(&bytes[j]))
                .unwrap_or(bytes.len());
            if bytes.get(end) == Some(&b'@')
                && let Some(colon) = bytes[start..end].iter().position(|&b| b == b':')
                && start + colon + 1 < end
            {
                masks.push((start + colon + 1, end));
            }
            i = end.max(i + 3);
            continue;
        }
        if let Some(word) = [&b"password"[..], b"passwd", b"pwd"]
            .into_iter()
            .find(|w| word_at(i, w))
        {
            let mut j = i + word.len();
            // The closing quote of a quoted key, as in JSON's "password": "…"
            if i > 0 && matches!(bytes[i - 1], b'\'' | b'"') && bytes.get(j) == Some(&bytes[i - 1])
            {
                j += 1;
            }
            j = skip_space(j);
            let assigned = matches!(bytes.get(j), Some(b'=' | b':'));
            if assigned {
                j = skip_space(j + 1);
            }
            mask_value(j, assigned, &mut masks);
            i += word.len();
            continue;
        }
        if word_at(i, b"identified") {
            let mut j = skip_space(i + "identified".len());
            // MySQL: IDENTIFIED WITH plugin BY 'secret'
            if word_at(j, b"with") {
                j = skip_space(j + 4);
                while j < bytes.len() && !bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                j = skip_space(j);
            }
            if word_at(j, b"by") {
                mask_value(skip_space(j + 2), false, &mut masks);
            }
            i += "identified".len();
            continue;
        }
        i += 1;
    }

    if masks.is_empty() {
        return text.to_owned();
    }
    masks.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, end) in masks {
        if start < copied {
            continue;
        }
        // Every mask starts and ends next to an ASCII byte, so these are char boundaries
        out.push_str(&text[copied..start]);
        out.push_str(MASK);
        copied = end;
    }
    out.push_str(&text[copied..]);
    out
}

#[tauri::command]
#[specta::specta]
pub async fn list_audit_events(
    filter: AuditFilter,
    audit: State<'_, Audit>,
) -> Result<AuditPage, CommandError> {
    audit.list(filter).await
}

#[tauri::command]
#[specta::specta]
pub async fn verify_audit_log(audit: State<'_, Audit>) -> Result<Verification, CommandError> {
    audit.verify().await
}

/// Returns the export as text; the UI saves it as a download. Rust takes no path from the UI,
/// so this can't be turned into a write-anywhere command.
#[tauri::command]
#[specta::specta]
pub async fn export_audit_log(
    format: ExportFormat,
    audit: State<'_, Audit>,
) -> Result<String, CommandError> {
    audit.export(format).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;

    /// A fresh directory per test, so tests can run in parallel.
    pub(crate) fn temp_dir() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("qc-audit-{}-{}-{n}", std::process::id(), now_ms()))
    }

    /// Every byte of the audit file, WAL included, after closing it.
    pub(crate) async fn file_text(audit: Audit, dir: &Path) -> String {
        audit.pool.unwrap().close().await;
        let mut text = String::new();
        for name in [FILE, "audit.db-wal"] {
            if let Ok(bytes) = std::fs::read(dir.join(name)) {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        text
    }

    fn query(sql: &str, error: Option<&str>) -> Details {
        Details {
            label: Some("shop@localhost".into()),
            engine: Some(Engine::Postgres),
            sql: Some(sql.into()),
            error: error.map(String::from),
            ..Default::default()
        }
    }

    fn filter() -> AuditFilter {
        AuditFilter {
            event: None,
            connection_id: None,
            search: None,
            from: None,
            to: None,
            before: None,
            limit: None,
        }
    }

    async fn seeded() -> (Audit, PathBuf) {
        let dir = temp_dir();
        let audit = Audit::open(&dir).await;
        audit
            .record(EventKind::ConnectionOpened, Some("a"), Details::default())
            .await;
        audit
            .record(
                EventKind::QueryRun,
                Some("a"),
                query("SELECT * FROM orders", None),
            )
            .await;
        audit
            .record(
                EventKind::QueryRun,
                Some("b"),
                query("SELEC 1", Some("syntax error")),
            )
            .await;
        (audit, dir)
    }

    #[tokio::test]
    async fn chains_entries_and_verifies() {
        let (audit, dir) = seeded().await;
        let report = audit.verify().await.unwrap();
        assert!(report.intact);
        assert_eq!(report.entries, 3);
        assert_eq!(audit.failed_writes.load(Ordering::Relaxed), 0);

        let pool = audit.pool().unwrap();
        let first: String = sqlx::query_scalar("SELECT prev_hash FROM audit_events WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(first, GENESIS);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn refuses_update_and_delete() {
        let (audit, dir) = seeded().await;
        let pool = audit.pool().unwrap();
        assert!(
            sqlx::query("UPDATE audit_events SET details = '{}'")
                .execute(pool)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM audit_events")
                .execute(pool)
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn verify_catches_an_edited_row() {
        let (audit, dir) = seeded().await;
        let pool = audit.pool().unwrap();
        // Someone with the file drops the guard and rewrites what a query was
        sqlx::raw_sql(
            "DROP TRIGGER audit_events_no_update;
             UPDATE audit_events SET details = replace(details, 'orders', 'customers') WHERE id = 2",
        )
        .execute(pool)
        .await
        .unwrap();
        let report = audit.verify().await.unwrap();
        assert!(!report.intact);
        assert_eq!(report.broken_id, Some(2));
        assert_eq!(report.entries, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn verify_catches_a_deleted_row() {
        let (audit, dir) = seeded().await;
        let pool = audit.pool().unwrap();
        sqlx::raw_sql("DROP TRIGGER audit_events_no_delete; DELETE FROM audit_events WHERE id = 2")
            .execute(pool)
            .await
            .unwrap();
        let report = audit.verify().await.unwrap();
        assert_eq!(report.broken_id, Some(3));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn filters_and_pages_newest_first() {
        let (audit, dir) = seeded().await;
        let ids = |page: &AuditPage| page.events.iter().map(|e| e.id).collect::<Vec<_>>();

        assert_eq!(ids(&audit.list(filter()).await.unwrap()), [3, 2, 1]);

        let queries = AuditFilter {
            event: Some(EventKind::QueryRun),
            ..filter()
        };
        assert_eq!(ids(&audit.list(queries).await.unwrap()), [3, 2]);

        let connection = AuditFilter {
            connection_id: Some("a".into()),
            ..filter()
        };
        assert_eq!(ids(&audit.list(connection).await.unwrap()), [2, 1]);

        // Case-insensitive, over values (SQL, error), not key names
        let search = |text: &str| AuditFilter {
            search: Some(text.into()),
            ..filter()
        };
        assert_eq!(ids(&audit.list(search("ORDERS")).await.unwrap()), [2]);
        assert_eq!(ids(&audit.list(search("syntax")).await.unwrap()), [3]);
        assert!(audit.list(search("sql")).await.unwrap().events.is_empty());
        assert!(audit.list(search("%")).await.unwrap().events.is_empty());

        let future = AuditFilter {
            from: Some(now_ms() + 60_000),
            ..filter()
        };
        assert!(audit.list(future).await.unwrap().events.is_empty());
        let past = AuditFilter {
            to: Some(now_ms() + 60_000),
            ..filter()
        };
        assert_eq!(audit.list(past).await.unwrap().events.len(), 3);

        let first = audit
            .list(AuditFilter {
                limit: Some(2),
                ..filter()
            })
            .await
            .unwrap();
        assert_eq!((ids(&first), first.next_cursor), (vec![3, 2], Some(2)));
        let second = audit
            .list(AuditFilter {
                limit: Some(2),
                before: first.next_cursor,
                ..filter()
            })
            .await
            .unwrap();
        assert_eq!((ids(&second), second.next_cursor), (vec![1], None));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn exports_csv_and_verifiable_json() {
        let (audit, dir) = seeded().await;
        let csv = audit.export(ExportFormat::Csv).await.unwrap();
        let lines: Vec<_> = csv.lines().collect();
        assert_eq!(lines.len(), 4);
        assert!(lines[0].starts_with("id,time_utc,event"));
        assert!(lines[2].contains("SELECT * FROM orders"));

        // The JSON export carries everything needed to re-check the chain
        let json = audit.export(ExportFormat::Json).await.unwrap();
        let entries: Vec<Value> = serde_json::from_str(&json).unwrap();
        let mut prev = GENESIS.to_owned();
        for e in &entries {
            let hash = chain_hash(
                &prev,
                e["id"].as_i64().unwrap(),
                e["atMs"].as_i64().unwrap(),
                e["event"].as_str().unwrap(),
                e["connectionId"].as_str(),
                &e["details"],
            );
            assert_eq!(Some(hash.as_str()), e["hash"].as_str());
            prev = e["hash"].as_str().unwrap().to_owned();
        }
        assert!(entries[0]["at"].as_str().unwrap().ends_with('Z'));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn counts_failed_writes_without_failing() {
        let audit = Audit {
            pool: Err("disk full".into()),
            failed_writes: AtomicU32::new(0),
        };
        audit
            .record(EventKind::QueryRun, None, Details::default())
            .await;
        assert_eq!(audit.failed_writes.load(Ordering::Relaxed), 1);
        assert!(audit.list(filter()).await.is_err());
    }

    #[tokio::test]
    async fn redacts_passwords_before_writing() {
        let dir = temp_dir();
        let audit = Audit::open(&dir).await;
        audit
            .record(
                EventKind::QueryRun,
                None,
                query(
                    "ALTER USER app WITH PASSWORD 'hunter2'; -- postgres://app:hunter2@db/shop",
                    Some("password=hunter2 rejected"),
                ),
            )
            .await;
        let text = file_text(audit, &dir).await;
        assert!(text.contains("ALTER USER app WITH PASSWORD"));
        assert!(!text.contains("hunter2"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn redacts_common_password_forms() {
        let cases = [
            (
                "postgres://app:s3cret@db:5432/shop",
                "postgres://app:***@db:5432/shop",
            ),
            ("mysql://root@db/shop", "mysql://root@db/shop"),
            (
                "host=db password=s3cret user=app",
                "host=db password=*** user=app",
            ),
            ("Server=db;Pwd=s3cret;", "Server=db;Pwd=***;"),
            (
                "CREATE ROLE a PASSWORD 'it''s'",
                "CREATE ROLE a PASSWORD '***'",
            ),
            (
                "CREATE USER a IDENTIFIED BY 's3cret'",
                "CREATE USER a IDENTIFIED BY '***'",
            ),
            (
                "ALTER USER a IDENTIFIED WITH mysql_native_password BY 's3cret'",
                "ALTER USER a IDENTIFIED WITH mysql_native_password BY '***'",
            ),
            (r#"{"password": "s3cret"}"#, r#"{"password": "***"}"#),
            (
                "SELECT password_hash FROM users",
                "SELECT password_hash FROM users",
            ),
            ("SELECT password FROM users", "SELECT password FROM users"),
            ("naïve ünïcode, no secrets", "naïve ünïcode, no secrets"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "{input}");
        }
    }
}
