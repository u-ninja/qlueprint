AI# Changelog

Shown in the "What's new" window after an update. One `## version` heading per release, one `- ` line per change.

## 0.3.1

- Updates: see what's new in a version before you install it, with download progress
- Fixed Create local database failing on macOS with "error getting credentials"

## 0.3.0

- Table graph: right-click a table in the explorer and choose View graph to see it with the tables it references and the tables that reference it, in a tab; each table can show its own connections, and a schema's menu has Show schema graph
- Edit a table's structure from the graph, the table inspector or a table's grid: add, rename and drop columns, add and drop indexes, link a column to another table, create and drop tables. Changes wait in the Changes panel as exact SQL until you apply them
- Fixed table details failing on PostgreSQL with "cannot cast type boolean to bigint"

## 0.2.2

- Date editor: pick a time zone for timestamp-with-time-zone columns; the value is saved in the column's zone

## 0.2.0

- Schedules: run a query on a timer, with each schedule's last runs shown (new Schedules view in the left rail)
- Closing the window keeps QluePrint running in the tray while a schedule is enabled; Quit is in the tray menu
- Settings › Background: start QluePrint at login, hidden in the tray

## 0.1.10

- A "What's new" window opens once after each update

## 0.1.9

- Row toolbar under every result: add, delete and duplicate rows, refresh, export to CSV or JSON, and a row limit
- Database and connection pickers have a search box
- Flatter buttons in light mode
