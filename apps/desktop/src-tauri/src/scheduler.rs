//! Scheduled queries: a saved SQL text that runs on a connection every N minutes while the app is
//! running (the window may be hidden, see the tray). Schedules live in `<app data>/schedules.json`
//! next to `connections.json`; each keeps its last runs. A run is audited like any query run, and
//! opens the saved connection first when it isn't open, with its password from the credential store.
//!
//! shortcut: intervals only, no time of day (no local-time crate in the tree); the first run is
//! due at the next tick after a schedule is created or the app starts, then every interval after
//! its last run. Runs missed while the app was closed are not replayed, one run catches up.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};

use crate::db::{CommandError, Connections, ErrorCode};
use crate::query::{self, MAX_ROWS};
use crate::saved::{self, Saved};

const FILE: &str = "schedules.json";
/// Runs kept per schedule, newest last.
const HISTORY: usize = 20;
/// How often due schedules are looked for; also the most a run can be late by.
const TICK: Duration = Duration::from_secs(15);
const MAX_MINUTES: u32 = 7 * 24 * 60;

/// One run of a schedule.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// When it started, milliseconds since the epoch.
    #[specta(type = specta_typescript::Number)]
    at: i64,
    ok: bool,
    #[specta(type = specta_typescript::Number)]
    rows: u64,
    duration_ms: u32,
    error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    id: String,
    name: String,
    connection_id: String,
    /// The toolbar's database, as for `run_query`; `None` is the connection's own.
    database: Option<String>,
    sql: String,
    every_minutes: u32,
    enabled: bool,
    #[serde(default)]
    history: Vec<Run>,
    /// A run is in progress. Memory only: cleared on load.
    #[serde(default)]
    running: bool,
}

/// What the UI sends to create or change a schedule; `id` `None` creates one.
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    id: Option<String>,
    name: String,
    connection_id: String,
    database: Option<String>,
    sql: String,
    every_minutes: u32,
    enabled: bool,
}

pub struct Schedules {
    file: PathBuf,
    // Held only to read or swap the list, never across an await.
    list: Mutex<Vec<Schedule>>,
}

fn invalid(message: &str) -> CommandError {
    CommandError::new(ErrorCode::InvalidInput, message)
}

fn now_ms() -> i64 {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    ms.try_into().unwrap_or(i64::MAX)
}

impl Schedule {
    /// When it is next due, `None` when it never ran: due now.
    fn next_due(&self) -> i64 {
        self.history
            .last()
            .map_or(0, |run| run.at + i64::from(self.every_minutes) * 60_000)
    }
}

impl Schedules {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join(FILE);
        let mut list: Vec<Schedule> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        for schedule in &mut list {
            schedule.running = false;
        }
        Self {
            file,
            list: Mutex::new(list),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Schedule>> {
        self.list.lock().expect("schedules lock poisoned")
    }

    /// Writes `list` to disk, then makes it current.
    fn replace(&self, list: Vec<Schedule>) -> Result<(), CommandError> {
        saved::write_json(&self.file, &list).map_err(|e| {
            CommandError::new(
                ErrorCode::SaveFailed,
                format!("Couldn't save the schedules: {e}"),
            )
        })?;
        *self.lock() = list;
        Ok(())
    }

    fn snapshot(&self) -> Vec<Schedule> {
        self.lock().clone()
    }

    /// Whether any schedule is enabled: closing the window then keeps the app running in the tray.
    pub fn any_enabled(&self) -> bool {
        self.lock().iter().any(|s| s.enabled)
    }

    /// Enabled schedules that are due and not running.
    fn due(&self, now: i64) -> Vec<String> {
        self.lock()
            .iter()
            .filter(|s| s.enabled && !s.running && s.next_due() <= now)
            .map(|s| s.id.clone())
            .collect()
    }

    /// Marks a schedule as running and returns it; an error when it is gone or already running.
    fn begin(&self, id: &str) -> Result<Schedule, CommandError> {
        let mut list = self.lock();
        let schedule = list
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| invalid("That schedule no longer exists."))?;
        if schedule.running {
            return Err(invalid("That schedule is already running."));
        }
        schedule.running = true;
        Ok(schedule.clone())
    }

    /// Records a finished run. A schedule deleted meanwhile just drops it.
    fn finish(&self, id: &str, run: Run) {
        let mut list = self.lock();
        if let Some(schedule) = list.iter_mut().find(|s| s.id == id) {
            schedule.running = false;
            schedule.history.push(run);
            let extra = schedule.history.len().saturating_sub(HISTORY);
            schedule.history.drain(..extra);
        }
        let snapshot = list.clone();
        drop(list);
        // A failed write loses only the history on disk; the next change writes it again
        let _ = saved::write_json(&self.file, &snapshot);
    }
}

/// Runs one schedule now and records the run. Never fails the caller on the query itself: that
/// goes in the history.
async fn run_one(app: &AppHandle, id: &str) -> Result<(), CommandError> {
    let schedules = app.state::<Schedules>();
    let schedule = schedules.begin(id)?;
    let at = now_ms();
    let started = Instant::now();
    let result = execute(app, &schedule).await;
    let run = Run {
        at,
        ok: result.is_ok(),
        rows: result.as_ref().map_or(0, |rows| *rows),
        duration_ms: query::elapsed_ms(started),
        error: result.err().map(|e| e.message().to_owned()),
    };
    schedules.finish(id, run);
    Ok(())
}

async fn execute(app: &AppHandle, schedule: &Schedule) -> Result<u64, CommandError> {
    saved::connect_saved(
        schedule.connection_id.clone(),
        app.state(),
        app.state(),
        app.state(),
    )
    .await?;
    let connections = app.state::<Connections>();
    let output = query::run_audited(
        &schedule.connection_id,
        schedule.sql.clone(),
        query::non_empty(schedule.database.clone()),
        MAX_ROWS,
        false,
        &connections,
        &app.state::<Saved>(),
        &app.state(),
    )
    .await?;
    Ok(output.rows_affected)
}

/// Starts the loop that runs due schedules, for as long as the app is.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            let due = app.state::<Schedules>().due(now_ms());
            for id in due {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_one(&app, &id).await;
                });
            }
        }
    });
}

#[tauri::command]
#[specta::specta]
pub fn list_schedules(schedules: State<'_, Schedules>) -> Vec<Schedule> {
    schedules.snapshot()
}

/// Creates or changes a schedule and returns it. Changing the SQL or interval keeps its history.
#[tauri::command]
#[specta::specta]
pub fn save_schedule(
    input: ScheduleInput,
    schedules: State<'_, Schedules>,
    saved: State<'_, Saved>,
) -> Result<Schedule, CommandError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(invalid("Give the schedule a name."));
    }
    if input.sql.trim().is_empty() {
        return Err(invalid("A schedule needs a query to run."));
    }
    if !(1..=MAX_MINUTES).contains(&input.every_minutes) {
        return Err(invalid("The interval must be 1 minute to 7 days."));
    }
    if saved.audit_details(&input.connection_id).is_none() {
        return Err(invalid("That connection is not saved."));
    }
    let mut list = schedules.snapshot();
    let existing = input
        .id
        .as_deref()
        .and_then(|id| list.iter().position(|s| s.id == id));
    let schedule = Schedule {
        id: input
            .id
            .filter(|_| existing.is_some())
            .unwrap_or_else(saved::new_id),
        name: name.to_owned(),
        connection_id: input.connection_id,
        database: query::non_empty(input.database),
        sql: input.sql,
        every_minutes: input.every_minutes,
        enabled: input.enabled,
        history: existing.map_or_else(Vec::new, |i| list[i].history.clone()),
        running: existing.is_some_and(|i| list[i].running),
    };
    match existing {
        Some(i) => list[i] = schedule.clone(),
        None => list.push(schedule.clone()),
    }
    schedules.replace(list)?;
    Ok(schedule)
}

#[tauri::command]
#[specta::specta]
pub fn delete_schedule(id: String, schedules: State<'_, Schedules>) -> Result<(), CommandError> {
    let list = schedules
        .snapshot()
        .into_iter()
        .filter(|s| s.id != id)
        .collect();
    schedules.replace(list)
}

/// Starts a run in the background and returns at once; the schedule shows `running` until it ends.
#[tauri::command]
#[specta::specta]
pub fn run_schedule_now(
    id: String,
    app: AppHandle,
    schedules: State<'_, Schedules>,
) -> Result<(), CommandError> {
    if schedules.snapshot().iter().any(|s| s.id == id && s.running) {
        return Err(invalid("That schedule is already running."));
    }
    tauri::async_runtime::spawn(async move {
        let _ = run_one(&app, &id).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(every_minutes: u32, last: Option<i64>, enabled: bool) -> Schedule {
        Schedule {
            id: "s".into(),
            name: "n".into(),
            connection_id: "c".into(),
            database: None,
            sql: "select 1".into(),
            every_minutes,
            enabled,
            history: last
                .map(|at| {
                    vec![Run {
                        at,
                        ok: true,
                        rows: 1,
                        duration_ms: 1,
                        error: None,
                    }]
                })
                .unwrap_or_default(),
            running: false,
        }
    }

    fn with(list: Vec<Schedule>) -> Schedules {
        Schedules {
            file: std::env::temp_dir().join("qc-schedules-test.json"),
            list: Mutex::new(list),
        }
    }

    #[test]
    fn due_when_never_run_or_interval_passed() {
        let now = 10 * 60_000;
        let s = with(vec![
            schedule(5, None, true),
            schedule(5, Some(now - 6 * 60_000), true),
            schedule(5, Some(now - 4 * 60_000), true),
            schedule(5, None, false),
        ]);
        assert_eq!(s.due(now).len(), 2);
    }

    #[test]
    fn a_running_schedule_is_not_due_and_cannot_start_twice() {
        let s = with(vec![schedule(1, None, true)]);
        assert!(s.begin("s").is_ok());
        assert!(s.due(i64::MAX).is_empty());
        assert!(s.begin("s").is_err());
    }

    #[test]
    fn history_keeps_the_newest_runs() {
        let s = with(vec![schedule(1, None, true)]);
        for at in 0..30 {
            s.finish(
                "s",
                Run {
                    at,
                    ok: true,
                    rows: 0,
                    duration_ms: 0,
                    error: None,
                },
            );
        }
        let kept = &s.snapshot()[0].history;
        assert_eq!(kept.len(), HISTORY);
        assert_eq!(kept.last().map(|r| r.at), Some(29));
    }
}
