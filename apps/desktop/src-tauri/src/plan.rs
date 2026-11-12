//! Explain: how the database would run (or, analyzed, did run) one statement, as a tree the UI
//! can draw the same way for every engine.

use serde::Serialize;
use serde_json::Value;
use specta::Type;
use tauri::State;

use crate::audit::Audit;
use crate::db::{CommandError, Connections, ErrorCode, Pool, invalid};
use crate::query::{MAX_ROWS, QueryOutput, non_empty, run_audited};
use crate::saved::Saved;

/// A full scan reading at least this many rows gets a "no index used" warning.
const FULL_SCAN_ROWS: f64 = 10_000.0;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    /// Pre-order: each node is followed by its children, one `depth` deeper.
    nodes: Vec<PlanNode>,
    /// What the database returned: JSON (SQL Server: showplan XML), or text for the formats in
    /// `engine_text`.
    raw: String,
    /// The statement ran (EXPLAIN ANALYZE), so the `actual_*` figures are filled in.
    analyzed: bool,
    /// Set when the engine only gave text (MySQL's EXPLAIN ANALYZE tree, the old tabular
    /// EXPLAIN): `nodes` are then parsed from it best-effort, and the text is the full story.
    engine_text: Option<String>,
}

#[derive(Debug, Default, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanNode {
    depth: u32,
    /// What the step does: "Seq Scan", "Hash Join", "Full table scan", "SEARCH"…
    kind: String,
    /// The table (or MySQL alias) it reads, when it reads one.
    relation: Option<String>,
    /// Index, join condition, filter, sort key…, as the database wrote them.
    detail: String,
    /// Per loop, as the database estimates them.
    est_rows: Option<f64>,
    /// Per loop, as counted when analyzed.
    actual_rows: Option<f64>,
    /// In the engine's own units: this step and everything under it, except MySQL's JSON
    /// format, which costs each table on its own.
    est_cost: Option<f64>,
    /// This step and everything under it, over all its loops.
    actual_ms: Option<f64>,
    loops: Option<f64>,
    warnings: Vec<String>,
}

/// Explains one statement. Plain Explain never runs it; `analyze` runs it for real timings and
/// row counts, so it's refused for anything but a single read (and on SQLite, which has no
/// EXPLAIN ANALYZE). The SQL sent, EXPLAIN (SQL Server: SET SHOWPLAN_XML) included, is audited as
/// a query run.
#[tauri::command]
#[specta::specta]
pub async fn explain_query(
    id: String,
    sql: String,
    database: Option<String>,
    analyze: bool,
    connections: State<'_, Connections>,
    saved: State<'_, Saved>,
    audit: State<'_, Audit>,
) -> Result<QueryPlan, CommandError> {
    let statement = one_statement(&sql)?;
    if analyze && !read_only(statement) {
        return Err(invalid(
            "Explain analyze runs the query, so it only works on a single read statement (SELECT, WITH…).",
        ));
    }
    let database = non_empty(database);
    let pool = connections.get(&id)?.pool;
    let run = |sql: String| {
        run_audited(
            &id,
            sql,
            database.clone(),
            MAX_ROWS,
            false,
            &connections,
            &saved,
            &audit,
        )
    };

    let (nodes, raw, engine_text) = match (pool, analyze) {
        (Pool::Postgres(_), _) => {
            let options = if analyze {
                "ANALYZE, BUFFERS, FORMAT JSON"
            } else {
                "FORMAT JSON"
            };
            let raw = first_cell(run(format!("EXPLAIN ({options}) {statement}")).await?);
            (parse_pg(&raw).map_err(unreadable)?, raw, None)
        }
        (Pool::Mysql(_), true) => {
            let text = first_cell(run(format!("EXPLAIN ANALYZE {statement}")).await?);
            (parse_mysql_tree(&text), text.clone(), Some(text))
        }
        (Pool::Mysql(_), false) => match run(format!("EXPLAIN FORMAT=JSON {statement}")).await {
            Ok(output) => {
                let raw = first_cell(output);
                (parse_mysql_json(&raw).map_err(unreadable)?, raw, None)
            }
            // Older MySQL and MariaDB: the classic table. If that fails too, the first error is
            // the one about the user's SQL
            Err(error) => {
                let output = run(format!("EXPLAIN {statement}"))
                    .await
                    .map_err(|_| error)?;
                let text = table_text(&output);
                (parse_mysql_table(&output), text.clone(), Some(text))
            }
        },
        (Pool::Mssql(_), _) => {
            // SHOWPLAN_XML must be alone in its batch; it returns the plan instead of running the
            // statement. STATISTICS XML runs it and adds the plan as the last result set. A
            // failed run closes its connection (mssql::run), so neither stays on
            let sql = if analyze {
                format!("SET STATISTICS XML ON;\n{statement};\nSET STATISTICS XML OFF")
            } else {
                format!("SET SHOWPLAN_XML ON\nGO\n{statement}\nGO\nSET SHOWPLAN_XML OFF")
            };
            let raw = first_cell(run(sql).await?);
            (parse_mssql(&raw).map_err(unreadable)?, raw, None)
        }
        (Pool::Sqlite(_), true) => {
            return Err(invalid(
                "SQLite has no EXPLAIN ANALYZE. Use Explain instead.",
            ));
        }
        (Pool::Sqlite(_), false) => {
            let output = run(format!("EXPLAIN QUERY PLAN {statement}")).await?;
            let nodes = parse_sqlite(&output);
            let raw = nodes
                .iter()
                .map(|n| format!("{}{}", "  ".repeat(n.depth as usize), sqlite_line(n)))
                .collect::<Vec<_>>()
                .join("\n");
            (nodes, raw, None)
        }
    };
    Ok(QueryPlan {
        nodes,
        raw,
        analyzed: analyze,
        engine_text,
    })
}

fn unreadable(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::QueryFailed,
        format!("Couldn’t read the plan: {e}"),
    )
}

/// `sql` trimmed and without its closing `;`, or an error when it's empty or more than one
/// statement. A `;` inside quotes or a comment doesn't count.
// shortcut: doesn't know Postgres $$ bodies or MySQL's \' escape, so `;` inside those reads as a
// second statement; lex them if people explain DO blocks or backslash-escaped strings
fn one_statement(sql: &str) -> Result<&str, CommandError> {
    let bytes = sql.as_bytes();
    let mut end = None;
    let mut i = 0;
    while i < bytes.len() {
        let next = bytes.get(i + 1).copied();
        match bytes[i] {
            b'-' if next == Some(b'-') => {
                i = sql[i..].find('\n').map_or(bytes.len(), |n| i + n);
                continue;
            }
            b'/' if next == Some(b'*') => {
                i = sql[i + 2..].find("*/").map_or(bytes.len(), |n| i + n + 4);
                continue;
            }
            c if c.is_ascii_whitespace() => {}
            // A stray second `;` is harmless
            b';' => end = end.or(Some(i)),
            _ if end.is_some() => {
                return Err(invalid(
                    "Explain works on one statement at a time. Select the one to explain.",
                ));
            }
            quote @ (b'\'' | b'"' | b'`') => {
                i = sql[i + 1..]
                    .find(quote as char)
                    .map_or(bytes.len(), |n| i + n + 1);
            }
            _ => {}
        }
        i += 1;
    }
    let statement = sql[..end.unwrap_or(sql.len())].trim();
    if statement.is_empty() {
        return Err(invalid("Write a query to explain."));
    }
    Ok(statement)
}

/// Same rule as the UI's `rerunnable`, minus SHOW and friends, which can't be explained: one
/// SELECT, WITH, VALUES or TABLE that names no write. Errs towards refusing (a string that
/// mentions "update" refuses too), since a wrong yes would run a write.
fn read_only(statement: &str) -> bool {
    let lower = statement.to_ascii_lowercase();
    let mut words = lower
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty());
    matches!(words.next(), Some("select" | "with" | "values" | "table"))
        && !words.any(|w| {
            matches!(
                w,
                "insert" | "update" | "delete" | "merge" | "into" | "call" | "do"
            )
        })
}

/// The first cell of the first row: where Postgres and MySQL put a JSON or text plan.
fn first_cell(output: QueryOutput) -> String {
    output
        .rows
        .into_iter()
        .next()
        .and_then(|row| row.into_iter().next().flatten())
        .unwrap_or_default()
}

/// A number from JSON, which MySQL often writes as a string ("1.25").
fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
}

/// "Full scan" for a scan reading `rows` or more.
fn full_scan(rows: Option<f64>) -> Vec<String> {
    match rows {
        Some(rows) if rows >= FULL_SCAN_ROWS => {
            vec![format!("Full scan: reads every row (~{rows:.0})")]
        }
        _ => Vec::new(),
    }
}

/// Postgres `EXPLAIN (FORMAT JSON)`: `[{"Plan": {…, "Plans": [children]}}]`.
fn parse_pg(json: &str) -> Result<Vec<PlanNode>, serde_json::Error> {
    let value: Value = serde_json::from_str(json)?;
    let mut nodes = Vec::new();
    for entry in value.as_array().into_iter().flatten() {
        if let Some(plan) = entry.get("Plan") {
            pg_node(plan, 0, &mut nodes);
        }
    }
    Ok(nodes)
}

fn pg_node(plan: &Value, depth: u32, nodes: &mut Vec<PlanNode>) {
    let text = |key| plan.get(key).and_then(Value::as_str);
    let figure = |key| number(plan.get(key));

    // Named as the text format names them: "Hash Left Join", "HashAggregate"
    let node_type = text("Node Type").unwrap_or("?");
    let kind = match (node_type, text("Join Type"), text("Strategy")) {
        (_, Some(join), _) if join != "Inner" && node_type.ends_with(" Join") => {
            format!("{} {join} Join", node_type.trim_end_matches(" Join"))
        }
        ("Nested Loop", Some(join), _) if join != "Inner" => format!("Nested Loop {join} Join"),
        ("Aggregate", _, Some("Hashed")) => "HashAggregate".into(),
        ("Aggregate", _, Some("Sorted")) => "GroupAggregate".into(),
        _ => node_type.into(),
    };

    let relation = text("Relation Name")
        .or(text("CTE Name"))
        .or(text("Function Name"));
    let mut detail = Vec::new();
    if let Some(alias) = text("Alias").filter(|a| Some(*a) != relation) {
        detail.push(format!("as {alias}"));
    }
    if let Some(index) = text("Index Name") {
        detail.push(format!("using {index}"));
    }
    for key in [
        "Hash Cond",
        "Merge Cond",
        "Index Cond",
        "Recheck Cond",
        "Join Filter",
        "Filter",
    ] {
        if let Some(condition) = text(key) {
            detail.push(format!("{key}: {condition}"));
        }
    }
    for key in ["Sort Key", "Group Key"] {
        if let Some(keys) = plan.get(key).and_then(Value::as_array) {
            let keys: Vec<_> = keys.iter().filter_map(Value::as_str).collect();
            detail.push(format!("{key}: {}", keys.join(", ")));
        }
    }

    let loops = figure("Actual Loops");
    let actual_rows = figure("Actual Rows");
    let est_rows = figure("Plan Rows");
    // Rows read: those kept plus those the filter dropped, else the estimate (kept rows only)
    let scanned = actual_rows.map_or(est_rows, |rows| {
        Some((rows + figure("Rows Removed by Filter").unwrap_or(0.0)) * loops.unwrap_or(1.0))
    });
    nodes.push(PlanNode {
        depth,
        warnings: if node_type == "Seq Scan" {
            full_scan(scanned)
        } else {
            Vec::new()
        },
        kind,
        relation: relation.map(str::to_owned),
        detail: detail.join(" · "),
        est_rows,
        actual_rows,
        est_cost: figure("Total Cost"),
        // Postgres times one loop; times the loops it's the step's whole share
        actual_ms: figure("Actual Total Time").map(|ms| ms * loops.unwrap_or(1.0)),
        loops,
    });
    for child in plan
        .get("Plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        pg_node(child, depth + 1, nodes);
    }
}

/// MySQL's `access_type` / `type`, in words.
fn mysql_access(access: &str) -> String {
    match access {
        "ALL" => "Full table scan",
        "index" => "Full index scan",
        "range" => "Index range scan",
        "ref" | "ref_or_null" => "Index lookup",
        "eq_ref" => "Unique index lookup",
        "const" | "system" => "Single row",
        "fulltext" => "Full-text search",
        "index_merge" => "Index merge",
        other => other,
    }
    .into()
}

/// MySQL `EXPLAIN FORMAT=JSON`: a `query_block` holding `table`s, `nested_loop`s and
/// operations (`ordering_operation`…) nested in each other. Each of those is a node; any other
/// object or array is searched for more (subqueries, unions), at the same depth.
fn parse_mysql_json(json: &str) -> Result<Vec<PlanNode>, serde_json::Error> {
    let value: Value = serde_json::from_str(json)?;
    let mut nodes = Vec::new();
    mysql_walk(&value, 0, &mut nodes);
    Ok(nodes)
}

fn mysql_walk(value: &Value, depth: u32, nodes: &mut Vec<PlanNode>) {
    match value {
        Value::Array(items) => items.iter().for_each(|v| mysql_walk(v, depth, nodes)),
        Value::Object(fields) => {
            for (key, v) in fields {
                let operation = match key.as_str() {
                    "table" => {
                        nodes.push(mysql_table(v, depth));
                        mysql_walk(v, depth + 1, nodes);
                        continue;
                    }
                    // "No tables used" and the like, for a query with no plan to speak of
                    "message" => {
                        if let Some(message) = v.as_str() {
                            nodes.push(PlanNode {
                                depth,
                                kind: message.into(),
                                ..Default::default()
                            });
                        }
                        continue;
                    }
                    "nested_loop" => "Nested loop",
                    "ordering_operation" => "Sort",
                    "grouping_operation" => "Group",
                    "duplicates_removal" => "Distinct",
                    "windowing" => "Window",
                    "union_result" => "Union",
                    "materialized_from_subquery" => "Materialize",
                    _ => {
                        mysql_walk(v, depth, nodes);
                        continue;
                    }
                };
                let flag = |name: &str| v.get(name).and_then(Value::as_bool) == Some(true);
                let detail = [
                    ("using_filesort", "filesort"),
                    ("using_temporary_table", "temporary table"),
                ]
                .iter()
                .filter(|(name, _)| flag(name))
                .map(|(_, label)| *label)
                .collect::<Vec<_>>()
                .join(" · ");
                nodes.push(PlanNode {
                    depth,
                    kind: operation.into(),
                    detail,
                    ..Default::default()
                });
                mysql_walk(v, depth + 1, nodes);
            }
        }
        _ => {}
    }
}

fn mysql_table(table: &Value, depth: u32) -> PlanNode {
    let text = |key| table.get(key).and_then(Value::as_str);
    let access = text("access_type").unwrap_or("");
    let mut detail = Vec::new();
    if let Some(key) = text("key") {
        detail.push(format!("using {key}"));
    }
    if let Some(condition) = text("attached_condition") {
        detail.push(format!("Filter: {condition}"));
    }
    // MariaDB says "rows"
    let est_rows = number(table.get("rows_examined_per_scan").or(table.get("rows")));
    let cost = table.get("cost_info");
    let cost = match (
        number(cost.and_then(|c| c.get("read_cost"))),
        number(cost.and_then(|c| c.get("eval_cost"))),
    ) {
        (None, None) => None,
        (read, eval) => Some(read.unwrap_or(0.0) + eval.unwrap_or(0.0)),
    };
    PlanNode {
        depth,
        kind: mysql_access(access),
        relation: text("table_name").map(str::to_owned),
        detail: detail.join(" · "),
        est_rows,
        est_cost: cost,
        warnings: if access == "ALL" {
            full_scan(est_rows)
        } else {
            Vec::new()
        },
        ..Default::default()
    }
}

/// The number at the start of `text`, e.g. "10) (actual…" → 10.
fn leading_number(text: &str) -> Option<f64> {
    let end = text
        .find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | '+' | '-')))
        .unwrap_or(text.len());
    text[..end].parse().ok()
}

/// The number after `key` in `text`: `figure("cost=1.5 rows=10", "rows=")` → 10.
fn figure(text: &str, key: &str) -> Option<f64> {
    leading_number(&text[text.find(key)? + key.len()..])
}

/// MySQL's tree text (EXPLAIN ANALYZE, FORMAT=TREE), one step per line, four spaces per level:
/// `-> Table scan on t  (cost=1.2 rows=10) (actual time=0.02..0.05 rows=10 loops=1)`.
fn parse_mysql_tree(text: &str) -> Vec<PlanNode> {
    text.lines()
        .filter_map(|line| {
            let body = line.trim_start();
            let indent = line.len() - body.len();
            let body = body.strip_prefix("-> ")?;
            let (label, figures) = body.split_at(body.find("  (").unwrap_or(body.len()));
            let (estimate, actual) = figures.split_once("(actual time=").unwrap_or((figures, ""));

            let (kind, relation, detail) = if let Some((kind, detail)) = label.split_once(": ") {
                (kind, None, detail)
            } else if let Some((kind, rest)) = label.split_once(" on ") {
                let (relation, detail) = rest.split_once(' ').unwrap_or((rest, ""));
                (kind, Some(relation), detail)
            } else if let Some((kind, _)) = label.split_once(" (") {
                (kind, None, &label[kind.len() + 1..])
            } else {
                (label, None, "")
            };

            let loops = figure(actual, "loops=");
            let est_rows = figure(estimate, "rows=");
            let actual_rows = figure(actual, "rows=");
            let read = actual_rows.map_or(est_rows, |rows| Some(rows * loops.unwrap_or(1.0)));
            Some(PlanNode {
                depth: (indent / 4) as u32,
                warnings: if kind == "Table scan" {
                    full_scan(read)
                } else {
                    Vec::new()
                },
                kind: kind.into(),
                relation: relation.map(str::to_owned),
                detail: detail.into(),
                est_rows,
                actual_rows,
                est_cost: figure(estimate, "cost="),
                // "first..last": ms to the last row of one loop
                actual_ms: actual
                    .split_once("..")
                    .and_then(|(_, last)| leading_number(last))
                    .map(|ms| ms * loops.unwrap_or(1.0)),
                loops,
            })
        })
        .collect()
}

/// SQL Server's showplan XML: a `RelOp` per step, nested in its parent's, with what it reads in
/// an `Object`, its filter in a `Predicate`, and (analyzed) counters per thread.
fn parse_mssql(xml: &str) -> Result<Vec<PlanNode>, quick_xml::Error> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut nodes: Vec<PlanNode> = Vec::new();
    // Indexes in `nodes` of the RelOps the reader is inside, innermost last
    let mut open: Vec<usize> = Vec::new();
    // Per node, the rows a scan reads (its estimate counts only those the predicate keeps)
    let mut read: Vec<Option<f64>> = Vec::new();
    let mut in_predicate = 0u32;
    loop {
        let (element, empty) = match reader.read_event()? {
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(e) => {
                match e.local_name().as_ref() {
                    "RelOp" => drop(open.pop()),
                    "Predicate" => in_predicate = in_predicate.saturating_sub(1),
                    _ => {}
                }
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        let attr = |name: &str| {
            element
                .try_get_attribute(name)
                .ok()
                .flatten()
                .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok())
                .map(|v| v.into_owned())
        };
        // Object names come quoted: [Order Details]
        let name = |key: &str| {
            attr(key).map(
                |v| match v.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
                    Some(inner) => inner.replace("]]", "]"),
                    None => v,
                },
            )
        };
        let figure = |name: &str| attr(name).and_then(|v| v.parse::<f64>().ok());
        let current = open.last().copied();
        match element.local_name().as_ref() {
            "RelOp" => {
                let physical = attr("PhysicalOp").unwrap_or_default();
                let kind = match attr("LogicalOp") {
                    Some(logical) if logical != physical => format!("{physical} ({logical})"),
                    _ => physical,
                };
                nodes.push(PlanNode {
                    depth: open.len() as u32,
                    kind,
                    est_rows: figure("EstimateRows"),
                    est_cost: figure("EstimatedTotalSubtreeCost"),
                    detail: figure("EstimatedRowsRead")
                        .map_or_else(String::new, |rows| format!("~{rows:.0} read")),
                    ..Default::default()
                });
                read.push(figure("EstimatedRowsRead"));
                if !empty {
                    open.push(nodes.len() - 1);
                }
            }
            "Object" => {
                if let Some(node) = current.map(|i| &mut nodes[i])
                    && node.relation.is_none()
                {
                    node.relation = name("Table");
                    let mut detail = Vec::new();
                    if let Some(alias) = name("Alias") {
                        detail.push(format!("as {alias}"));
                    }
                    if let Some(index) = name("Index") {
                        detail.push(format!("using {index}"));
                    }
                    detail.extend(Some(std::mem::take(&mut node.detail)).filter(|d| !d.is_empty()));
                    node.detail = detail.join(" · ");
                }
            }
            "Predicate" if !empty => in_predicate += 1,
            "ScalarOperator" if in_predicate > 0 => {
                if let (Some(node), Some(condition)) =
                    (current.map(|i| &mut nodes[i]), attr("ScalarString"))
                    && !node.detail.contains("Filter: ")
                {
                    let sep = if node.detail.is_empty() { "" } else { " · " };
                    node.detail = format!("{}{sep}Filter: {condition}", node.detail);
                }
            }
            // One per thread: rows and executions add up, the slowest thread is the time
            "RunTimeCountersPerThread" => {
                if let Some(node) = current.map(|i| &mut nodes[i]) {
                    let add = |total: Option<f64>, value| match value {
                        Some(v) => Some(total.unwrap_or(0.0) + v),
                        None => total,
                    };
                    node.actual_rows = add(node.actual_rows, figure("ActualRows"));
                    node.loops = add(node.loops, figure("ActualExecutions"));
                    if let Some(ms) = figure("ActualElapsedms") {
                        node.actual_ms = Some(node.actual_ms.map_or(ms, |t: f64| t.max(ms)));
                    }
                }
            }
            _ => {}
        }
    }
    for (node, read) in nodes.iter_mut().zip(read) {
        if matches!(
            node.kind.as_str(),
            "Table Scan" | "Clustered Index Scan" | "Index Scan"
        ) {
            node.warnings = full_scan(node.actual_rows.or(read).or(node.est_rows));
        }
    }
    Ok(nodes)
}

/// A column of a result by name, in any case.
fn column(output: &QueryOutput, name: &str) -> Option<usize> {
    output
        .columns
        .iter()
        .position(|c| c.name.eq_ignore_ascii_case(name))
}

/// The classic `EXPLAIN` table (MySQL before 5.6, MariaDB): one row per table, in join order.
fn parse_mysql_table(output: &QueryOutput) -> Vec<PlanNode> {
    let [table, access, key, rows, extra] =
        ["table", "type", "key", "rows", "Extra"].map(|name| column(output, name));
    let cell = |row: &[Option<String>], at: Option<usize>| at.and_then(|i| row[i].clone());
    output
        .rows
        .iter()
        .map(|row| {
            let access = cell(row, access).unwrap_or_default();
            let est_rows = cell(row, rows).and_then(|r| r.parse().ok());
            let mut detail = Vec::new();
            if let Some(key) = cell(row, key) {
                detail.push(format!("using {key}"));
            }
            detail.extend(cell(row, extra).filter(|e| !e.is_empty()));
            PlanNode {
                warnings: if access == "ALL" {
                    full_scan(est_rows)
                } else {
                    Vec::new()
                },
                kind: mysql_access(&access),
                relation: cell(row, table),
                detail: detail.join(" · "),
                est_rows,
                ..Default::default()
            }
        })
        .collect()
}

/// A result as tab-separated text, header first, NULL for SQL NULL.
fn table_text(output: &QueryOutput) -> String {
    let header = output
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join("\t");
    let rows = output.rows.iter().map(|row| {
        row.iter()
            .map(|c| c.as_deref().unwrap_or("NULL"))
            .collect::<Vec<_>>()
            .join("\t")
    });
    std::iter::once(header)
        .chain(rows)
        .collect::<Vec<_>>()
        .join("\n")
}

/// SQLite `EXPLAIN QUERY PLAN`: rows of (id, parent, notused, detail), parents before children,
/// e.g. "SEARCH t USING INDEX t_a (a=?)" or, before SQLite 3.36, "SEARCH TABLE t USING …".
fn parse_sqlite(output: &QueryOutput) -> Vec<PlanNode> {
    let mut depths: Vec<(String, u32)> = Vec::new();
    output
        .rows
        .iter()
        .map(|row| {
            let text = |i: usize| row.get(i).cloned().flatten().unwrap_or_default();
            let (id, parent, line) = (text(0), text(1), text(3));
            let depth = depths
                .iter()
                .find(|(id, _)| *id == parent)
                .map_or(0, |(_, d)| d + 1);
            depths.push((id, depth));

            let (kind, relation, detail) = match line.split_once(' ') {
                Some((verb @ ("SCAN" | "SEARCH"), rest)) if !rest.starts_with("CONSTANT ROW") => {
                    let rest = rest.strip_prefix("TABLE ").unwrap_or(rest);
                    let (relation, detail) = rest.split_once(' ').unwrap_or((rest, ""));
                    (
                        verb.to_owned(),
                        Some(relation.to_owned()),
                        detail.to_owned(),
                    )
                }
                _ => (line, None, String::new()),
            };
            PlanNode {
                depth,
                kind,
                relation,
                detail,
                ..Default::default()
            }
        })
        .collect()
}

/// A SQLite node back as the line it came from, for the raw view.
fn sqlite_line(node: &PlanNode) -> String {
    [
        Some(node.kind.as_str()),
        node.relation.as_deref(),
        Some(node.detail.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::{collect, sqlite_cell, sqlite_type};
    use sqlx::sqlite::{SqlitePoolOptions, SqliteQueryResult};

    /// (depth, kind, relation) of each node, for compact assertions.
    fn shape(nodes: &[PlanNode]) -> Vec<(u32, &str, Option<&str>)> {
        nodes
            .iter()
            .map(|n| (n.depth, n.kind.as_str(), n.relation.as_deref()))
            .collect()
    }

    #[test]
    fn takes_one_statement() {
        assert_eq!(one_statement("  SELECT 1;  ").unwrap(), "SELECT 1");
        assert_eq!(
            one_statement("SELECT ';' AS x -- a; comment\n;\n/* b; */").unwrap(),
            "SELECT ';' AS x -- a; comment"
        );
        assert_eq!(
            one_statement("SELECT \"a;b\" FROM `c;d`").unwrap(),
            "SELECT \"a;b\" FROM `c;d`"
        );
        assert!(
            one_statement("SELECT 1; SELECT 2")
                .unwrap_err()
                .message()
                .starts_with("Explain works on one statement")
        );
        assert!(one_statement(" ; -- nothing").is_err());
        assert!(one_statement("").is_err());
    }

    #[test]
    fn analyzes_only_reads() {
        assert!(read_only("SELECT * FROM t"));
        assert!(read_only("with x as (select 1) select * from x"));
        assert!(!read_only(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(!read_only("SELECT 1 INTO @x"));
        assert!(!read_only("UPDATE t SET a = 1"));
        assert!(!read_only("SHOW TABLES"));
    }

    const PG_ANALYZED: &str = r#"[
      {
        "Plan": {
          "Node Type": "Sort", "Parallel Aware": false, "Startup Cost": 1830.21, "Total Cost": 1833.33,
          "Plan Rows": 1248, "Plan Width": 48, "Actual Startup Time": 24.1, "Actual Total Time": 26.4,
          "Actual Rows": 1248, "Actual Loops": 1, "Sort Key": ["c.mrr DESC"],
          "Sort Method": "quicksort", "Sort Space Used": 212, "Sort Space Type": "Memory",
          "Plans": [
            {
              "Node Type": "Hash Join", "Parent Relationship": "Outer", "Join Type": "Right",
              "Startup Cost": 40.08, "Total Cost": 1766.2, "Plan Rows": 1248, "Plan Width": 48,
              "Actual Startup Time": 0.9, "Actual Total Time": 21.7, "Actual Rows": 18412, "Actual Loops": 1,
              "Hash Cond": "(o.customer_id = c.id)",
              "Plans": [
                {
                  "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Relation Name": "orders",
                  "Alias": "o", "Startup Cost": 0.0, "Total Cost": 1420.12, "Plan Rows": 60, "Plan Width": 16,
                  "Actual Startup Time": 0.01, "Actual Total Time": 12.2, "Actual Rows": 18412, "Actual Loops": 1,
                  "Filter": "(status = 'paid'::text)", "Rows Removed by Filter": 41588
                },
                {
                  "Node Type": "Hash", "Parent Relationship": "Inner", "Total Cost": 24.48, "Plan Rows": 1248,
                  "Actual Total Time": 0.8, "Actual Rows": 1248, "Actual Loops": 1,
                  "Plans": [
                    {
                      "Node Type": "Index Scan", "Parent Relationship": "Outer", "Scan Direction": "Forward",
                      "Index Name": "idx_customers_created_at", "Relation Name": "customers", "Alias": "c",
                      "Total Cost": 24.48, "Plan Rows": 1248, "Actual Total Time": 0.05, "Actual Rows": 4,
                      "Actual Loops": 4, "Index Cond": "(created_at > '2024-01-01'::date)"
                    }
                  ]
                }
              ]
            }
          ]
        },
        "Planning Time": 0.4,
        "Triggers": [],
        "Execution Time": 27.1
      }
    ]"#;

    #[test]
    fn parses_postgres_json() {
        let nodes = parse_pg(PG_ANALYZED).unwrap();
        assert_eq!(
            shape(&nodes),
            [
                (0, "Sort", None),
                (1, "Hash Right Join", None),
                (2, "Seq Scan", Some("orders")),
                (2, "Hash", None),
                (3, "Index Scan", Some("customers")),
            ]
        );
        assert_eq!(nodes[0].detail, "Sort Key: c.mrr DESC");
        assert_eq!(nodes[1].detail, "Hash Cond: (o.customer_id = c.id)");
        let scan = &nodes[2];
        assert_eq!(scan.detail, "as o · Filter: (status = 'paid'::text)");
        assert_eq!(
            (scan.est_rows, scan.actual_rows, scan.est_cost),
            (Some(60.0), Some(18412.0), Some(1420.12))
        );
        // Kept plus filtered out: 60,000 rows read
        assert_eq!(scan.warnings, ["Full scan: reads every row (~60000)"]);
        let index = &nodes[4];
        assert_eq!(
            index.detail,
            "as c · using idx_customers_created_at · Index Cond: (created_at > '2024-01-01'::date)"
        );
        assert_eq!((index.loops, index.actual_ms), (Some(4.0), Some(0.2)));
        assert!(index.warnings.is_empty());
    }

    #[test]
    fn parses_an_estimated_postgres_plan() {
        let json = r#"[{"Plan": {"Node Type": "Aggregate", "Strategy": "Hashed", "Total Cost": 12.5, "Plan Rows": 3,
            "Group Key": ["plan"], "Plans": [{"Node Type": "Seq Scan", "Relation Name": "customers",
            "Alias": "customers", "Total Cost": 10.0, "Plan Rows": 1248}]}}]"#;
        let nodes = parse_pg(json).unwrap();
        assert_eq!(
            shape(&nodes),
            [
                (0, "HashAggregate", None),
                (1, "Seq Scan", Some("customers"))
            ]
        );
        assert_eq!(nodes[0].detail, "Group Key: plan");
        assert_eq!((nodes[1].actual_rows, nodes[1].actual_ms), (None, None));
        assert!(nodes[1].warnings.is_empty());
    }

    const MYSQL_JSON: &str = r#"{
      "query_block": {
        "select_id": 1,
        "cost_info": { "query_cost": "2451.30" },
        "ordering_operation": {
          "using_filesort": true,
          "using_temporary_table": true,
          "nested_loop": [
            {
              "table": {
                "table_name": "o",
                "access_type": "ALL",
                "possible_keys": ["idx_customer"],
                "rows_examined_per_scan": 59840,
                "rows_produced_per_join": 5984,
                "filtered": "10.00",
                "cost_info": { "read_cost": "554.10", "eval_cost": "598.40", "prefix_cost": "1152.50", "data_read_per_join": "1M" },
                "used_columns": ["id", "customer_id", "status"],
                "attached_condition": "(`shop`.`o`.`status` = 'paid')"
              }
            },
            {
              "table": {
                "table_name": "c",
                "access_type": "eq_ref",
                "possible_keys": ["PRIMARY"],
                "key": "PRIMARY",
                "used_key_parts": ["id"],
                "key_length": "8",
                "ref": ["shop.o.customer_id"],
                "rows_examined_per_scan": 1,
                "rows_produced_per_join": 5984,
                "filtered": "100.00",
                "cost_info": { "read_cost": "1495.98", "eval_cost": "598.40", "prefix_cost": "3246.88", "data_read_per_join": "2M" },
                "used_columns": ["id", "name"]
              }
            }
          ]
        }
      }
    }"#;

    #[test]
    fn parses_mysql_json() {
        let nodes = parse_mysql_json(MYSQL_JSON).unwrap();
        assert_eq!(
            shape(&nodes),
            [
                (0, "Sort", None),
                (1, "Nested loop", None),
                (2, "Full table scan", Some("o")),
                (2, "Unique index lookup", Some("c")),
            ]
        );
        assert_eq!(nodes[0].detail, "filesort · temporary table");
        let scan = &nodes[2];
        assert_eq!(scan.detail, "Filter: (`shop`.`o`.`status` = 'paid')");
        assert_eq!(scan.est_rows, Some(59840.0));
        assert!((scan.est_cost.unwrap() - 1152.5).abs() < 1e-9);
        assert_eq!(scan.warnings.len(), 1);
        assert_eq!(nodes[3].detail, "using PRIMARY");
        assert!(nodes[3].warnings.is_empty());

        let nodes =
            parse_mysql_json(r#"{"query_block": {"select_id": 1, "message": "No tables used"}}"#)
                .unwrap();
        assert_eq!(shape(&nodes), [(0, "No tables used", None)]);
    }

    #[test]
    fn parses_mysql_tree_text() {
        let text = "-> Sort: c.`name`  (actual time=31.2..31.4 rows=120 loops=1)
    -> Nested loop inner join  (cost=2451.30 rows=5984) (actual time=0.2..30.1 rows=120 loops=1)
        -> Filter: (o.`status` = 'paid')  (cost=1152.50 rows=5984) (actual time=0.1..25.3 rows=120 loops=1)
            -> Table scan on o  (cost=1152.50 rows=59840) (actual time=0.09..21.0 rows=60000 loops=1)
        -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.25 rows=1) (actual time=0.01..0.25 rows=1 loops=120)
";
        let nodes = parse_mysql_tree(text);
        assert_eq!(
            shape(&nodes),
            [
                (0, "Sort", None),
                (1, "Nested loop inner join", None),
                (2, "Filter", None),
                (3, "Table scan", Some("o")),
                (2, "Single-row index lookup", Some("c")),
            ]
        );
        assert_eq!(nodes[2].detail, "(o.`status` = 'paid')");
        assert_eq!(nodes[4].detail, "using PRIMARY (id=o.customer_id)");
        let scan = &nodes[3];
        assert_eq!(
            (
                scan.est_rows,
                scan.actual_rows,
                scan.est_cost,
                scan.actual_ms
            ),
            (Some(59840.0), Some(60000.0), Some(1152.5), Some(21.0))
        );
        assert_eq!(scan.warnings.len(), 1);
        assert_eq!(
            (nodes[4].loops, nodes[4].actual_ms),
            (Some(120.0), Some(30.0))
        );
        assert_eq!(nodes[0].est_cost, None);
    }

    const MSSQL_PLAN: &str = r#"<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564" Build="16.0.4135.4">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementText="SELECT c.name FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id WHERE o.status = 'paid'" StatementType="SELECT">
      <QueryPlan CachedPlanSize="24">
        <RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="5984" EstimatedTotalSubtreeCost="2.4513">
          <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="120" ActualExecutions="1" ActualElapsedms="31"/></RunTimeInformation>
          <Hash>
            <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="5984" EstimatedRowsRead="59840" EstimatedTotalSubtreeCost="1.1525">
              <RunTimeInformation>
                <RunTimeCountersPerThread Thread="1" ActualRows="60" ActualExecutions="1" ActualElapsedms="20"/>
                <RunTimeCountersPerThread Thread="2" ActualRows="60000" ActualExecutions="1" ActualElapsedms="21"/>
              </RunTimeInformation>
              <IndexScan Ordered="0">
                <Object Database="[shop]" Schema="[dbo]" Table="[orders]" Index="[PK_orders]" Alias="[o]" IndexKind="Clustered"/>
                <Predicate><ScalarOperator ScalarString="[shop].[dbo].[orders].[status] as [o].[status]=N'paid'"><Compare CompareOp="EQ"><ScalarOperator><Identifier/></ScalarOperator></Compare></ScalarOperator></Predicate>
              </IndexScan>
            </RelOp>
            <RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.0032">
              <IndexScan><Object Database="[shop]" Schema="[dbo]" Table="[customers]" Index="[IX_customers_id]" Alias="[c]"/></IndexScan>
            </RelOp>
          </Hash>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>"#;

    #[test]
    fn parses_mssql_showplan_xml() {
        let nodes = parse_mssql(MSSQL_PLAN).unwrap();
        assert_eq!(
            shape(&nodes),
            [
                (0, "Hash Match (Inner Join)", None),
                (1, "Clustered Index Scan", Some("orders")),
                (1, "Index Seek", Some("customers")),
            ]
        );
        assert_eq!(
            (
                nodes[0].est_rows,
                nodes[0].est_cost,
                nodes[0].actual_rows,
                nodes[0].actual_ms
            ),
            (Some(5984.0), Some(2.4513), Some(120.0), Some(31.0))
        );
        let scan = &nodes[1];
        assert_eq!(
            scan.detail,
            "as o · using PK_orders · ~59840 read · Filter: [shop].[dbo].[orders].[status] as [o].[status]=N'paid'"
        );
        // Both threads' rows, the slower thread's time
        assert_eq!(
            (scan.actual_rows, scan.loops, scan.actual_ms),
            (Some(60060.0), Some(2.0), Some(21.0))
        );
        assert_eq!(scan.warnings, ["Full scan: reads every row (~60060)"]);
        assert_eq!(nodes[2].detail, "as c · using IX_customers_id");
        assert!(nodes[2].warnings.is_empty());
        assert!(parse_mssql("<ShowPlanXML><RelOp></ShowPlanXML>").is_err());
    }

    #[tokio::test]
    async fn explains_sqlite_index_and_scan() {
        // One connection: every connection to sqlite::memory: is its own empty database
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, a INT, b INT); CREATE INDEX t_a ON t (a)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let plan = |sql: &'static str| {
            let pool = pool.clone();
            async move {
                let results = sqlx::raw_sql(sql).fetch_many(&pool);
                let output = collect(
                    results,
                    MAX_ROWS,
                    SqliteQueryResult::rows_affected,
                    sqlite_cell,
                    sqlite_type,
                )
                .await
                .unwrap();
                parse_sqlite(&output)
            }
        };

        let nodes = plan("EXPLAIN QUERY PLAN SELECT * FROM t WHERE a = 1").await;
        assert_eq!(shape(&nodes), [(0, "SEARCH", Some("t"))]);
        assert_eq!(nodes[0].detail, "USING INDEX t_a (a=?)");

        let nodes = plan("EXPLAIN QUERY PLAN SELECT * FROM t WHERE b = 1").await;
        assert_eq!(shape(&nodes), [(0, "SCAN", Some("t"))]);

        // A subquery nests under the step that runs it
        let nodes = plan("EXPLAIN QUERY PLAN SELECT * FROM t WHERE b IN (SELECT a FROM t WHERE b > 2) ORDER BY b").await;
        assert!(nodes.iter().any(|n| n.depth > 0), "{nodes:?}");
        assert!(nodes.iter().any(|n| n.kind.contains("B-TREE")), "{nodes:?}");
    }
}
