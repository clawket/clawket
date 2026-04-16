mod client;
mod paths;
mod daemon;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::json;

#[derive(Parser)]
#[command(name = "clawket", version, about = "LLM-native work management CLI for Claude Code.\n\nWorkflow: Project → Plan (approve) → Unit → Task (backlog) → Cycle (activate) → Start\n\nPlan must be approved (draft → active) before tasks can be started.\nTasks can be created without a cycle (goes to backlog).\nStarting a task (in_progress) requires an assigned active cycle.\nCycle must be activated (planning → active) before tasks can be started.\nUnit is a pure grouping entity with no status.\nTask is the only entity managed directly: todo → in_progress → done/cancelled.\nCompleted cycles cannot be restarted — create a new one.\n\nQuick start:\n  clawket project create \"my-app\" --cwd .\n  clawket plan create --project PROJ-my-app \"MVP\"\n  clawket plan approve PLAN-xxx\n  clawket unit create --plan PLAN-xxx \"Unit 1\"\n  clawket task create \"Build login\" --assignee main          # goes to backlog\n  clawket cycle create --project PROJ-my-app \"Sprint 1\"\n  clawket cycle activate CYC-xxx\n  clawket task update TASK-xxx --cycle CYC-xxx             # assign to cycle\n  clawket task update TASK-xxx --status in_progress\n  clawket task update TASK-xxx --status done")]
struct Cli {
    /// Output format: json (default), table, yaml
    #[arg(long, global = true, default_value = "json")]
    format: String,
    /// Quiet mode: only output the entity ID
    #[arg(short, long, global = true)]
    quiet: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show work dashboard for current project (SessionStart context injection)
    Dashboard {
        /// Working directory to detect project
        #[arg(long)]
        cwd: Option<String>,
        /// Filter: active | next | all (default: all)
        #[arg(long, default_value = "all")]
        show: String,
    },
    /// Manage clawketd daemon
    #[command(alias = "d")]
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    /// Manage projects
    #[command(alias = "proj")]
    Project {
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// Manage plans
    #[command(alias = "pl")]
    Plan {
        #[command(subcommand)]
        action: PlanAction,
    },
    /// Manage units
    #[command(alias = "u")]
    Unit {
        #[command(subcommand)]
        action: UnitAction,
    },
    /// Manage cycles (time-boxed iterations)
    #[command(alias = "cy")]
    Cycle {
        #[command(subcommand)]
        action: CycleAction,
    },
    /// Manage tasks
    #[command(alias = "t")]
    Task {
        #[command(subcommand)]
        action: TaskAction,
    },
    /// Manage artifacts
    #[command(alias = "art")]
    Artifact {
        #[command(subcommand)]
        action: ArtifactAction,
    },
    /// Manage runs
    #[command(alias = "r")]
    Run {
        #[command(subcommand)]
        action: RunAction,
    },
    /// Manage task comments
    #[command(alias = "c")]
    Comment {
        #[command(subcommand)]
        action: CommentAction,
    },
    /// Manage questions
    #[command(alias = "q")]
    Question {
        #[command(subcommand)]
        action: QuestionAction,
    },
}

// ========== Daemon ==========
#[derive(Subcommand)]
pub enum DaemonAction {
    /// Start the clawketd daemon in the background (HTTP on localhost:19400 + Unix socket)
    Start,
    /// Stop the running clawketd daemon
    Stop,
    /// Show daemon status (PID, uptime, version)
    Status,
    /// Restart the daemon (stop + start)
    Restart,
}

// ========== Project ==========
#[derive(Subcommand)]
enum ProjectAction {
    /// Create a new project. Each project maps to one or more working directories.
    Create {
        /// Project name (used to generate ID: PROJ-<slugified-name>)
        name: String,
        /// Project description
        #[arg(long)]
        description: Option<String>,
        /// Working directory to associate (defaults to current dir)
        #[arg(long)]
        cwd: Option<String>,
        /// Short uppercase key for ticket numbers (e.g. LAT → LAT-1, LAT-2)
        #[arg(long)]
        key: Option<String>,
    },
    /// View project details by ID
    View {
        /// Project ID
        id: String,
    },
    /// List all projects
    List,
    /// Update project properties
    Update {
        /// Project ID
        id: String,
        /// New project name
        #[arg(long)]
        name: Option<String>,
        /// New project description
        #[arg(long)]
        description: Option<String>,
        /// Wiki root paths as JSON array, e.g. '["docs","wiki","/absolute/path"]'
        #[arg(long)]
        wiki_paths: Option<String>,
    },
    /// Delete a project and all associated data
    Delete {
        /// Project ID
        id: String,
    },
    /// Manage working directories for a project
    Cwd {
        #[command(subcommand)]
        action: ProjectCwdAction,
    },
}

#[derive(Subcommand)]
enum ProjectCwdAction {
    /// Add a working directory to the project
    Add {
        /// Project ID
        id: String,
        /// Directory path to add (defaults to current dir)
        #[arg(long)]
        path: Option<String>,
    },
    /// Remove a working directory from the project
    Remove {
        /// Project ID
        id: String,
        /// Directory path to remove
        #[arg(long)]
        path: String,
    },
    /// List working directories for a project
    List {
        /// Project ID
        id: String,
    },
}

// ========== Plan ==========
#[derive(Subcommand)]
enum PlanAction {
    /// Create a new plan. Plans start as 'draft' and must be approved before work can begin.
    /// Tasks can be created under draft plans (as todo) but cannot be started (in_progress).
    Create {
        /// Plan title
        title: String,
        /// Project ID this plan belongs to
        #[arg(long)]
        project: String,
        /// Plan description
        #[arg(long)]
        description: Option<String>,
        /// Source: manual (default) or import
        #[arg(long, default_value = "manual")]
        source: String,
        /// Source file path (for imported plans)
        #[arg(long)]
        source_path: Option<String>,
    },
    /// View plan details
    View {
        /// Plan ID
        id: String,
    },
    /// List plans with optional filters
    List {
        /// Filter by project ID
        #[arg(long)]
        project_id: Option<String>,
        /// Filter by status: draft, active, completed
        #[arg(long)]
        status: Option<String>,
    },
    /// Update plan properties. Status: draft, active, completed
    Update {
        /// Plan ID
        id: String,
        /// New plan title
        #[arg(long)]
        title: Option<String>,
        /// New plan description
        #[arg(long)]
        description: Option<String>,
        /// Plan status: draft, active, completed. Use 'approve' command for draft → active.
        #[arg(long)]
        status: Option<String>,
    },
    /// Delete a plan
    Delete {
        /// Plan ID
        id: String,
    },
    /// Approve a draft plan (draft → active). Required before tasks can be started.
    Approve {
        /// Plan ID
        id: String,
    },
    /// Mark an active plan as completed (active → completed)
    Complete {
        /// Plan ID
        id: String,
    },
    /// Import a plan from a markdown file
    Import {
        /// Path to plan markdown file
        file: String,
        /// Project name to attach the plan to (created if missing)
        #[arg(long)]
        project: Option<String>,
        /// Working directory (used when project is omitted)
        #[arg(long)]
        cwd: Option<String>,
        /// Source label recorded on the plan (default: "import")
        #[arg(long, default_value = "import")]
        source: String,
        /// Preview the parsed plan without creating entities
        #[arg(long)]
        dry_run: bool,
    },
}

// ========== Unit ==========
#[derive(Subcommand)]
enum UnitAction {
    /// Create a new unit (grouping entity within a plan).
    /// Tasks in a parallel unit can be executed by multiple agents simultaneously.
    Create {
        /// Unit title
        title: String,
        /// Plan ID this unit belongs to
        #[arg(long)]
        plan: String,
        /// Unit goal description
        #[arg(long)]
        goal: Option<String>,
        /// Sort order within plan
        #[arg(long)]
        idx: Option<i64>,
        /// Execution mode: sequential (default) or parallel (multi-agent)
        #[arg(long, default_value = "sequential")]
        mode: String,
    },
    /// View unit details
    View {
        /// Unit ID
        id: String,
    },
    /// List units with optional filters
    List {
        /// Filter by plan ID
        #[arg(long)]
        plan_id: Option<String>,
    },
    /// Update unit properties
    Update {
        /// Unit ID
        id: String,
        /// New unit title
        #[arg(long)]
        title: Option<String>,
        /// Unit goal description
        #[arg(long)]
        goal: Option<String>,
        /// Execution mode: sequential or parallel (multi-agent)
        #[arg(long)]
        mode: Option<String>,
    },
    /// Delete a unit
    Delete {
        /// Unit ID
        id: String,
    },
}

// ========== Cycle ==========
#[derive(Subcommand)]
enum CycleAction {
    /// Create a new cycle (sprint). Starts in 'planning' status.
    /// Cycles are time-boxed iterations that pull tasks from any unit/plan.
    /// Multiple active cycles per project are supported (parallel cycles).
    Create {
        /// Cycle title (e.g. "Sprint 1", "v2.0 Cycle")
        title: String,
        /// Project ID this cycle belongs to
        #[arg(long)]
        project: String,
        /// Sprint goal
        #[arg(long)]
        goal: Option<String>,
        /// Sort order
        #[arg(long)]
        idx: Option<i64>,
    },
    /// View cycle details
    View {
        /// Cycle ID
        id: String,
    },
    /// List cycles with optional filters
    List {
        /// Filter by project ID
        #[arg(long)]
        project_id: Option<String>,
        /// Filter by status: planning, active, completed
        #[arg(long)]
        status: Option<String>,
    },
    /// Update cycle properties. Status: planning, active, completed.
    /// Completed cycles cannot be restarted — create a new cycle instead.
    Update {
        /// Cycle ID
        id: String,
        /// New cycle title
        #[arg(long)]
        title: Option<String>,
        /// Sprint goal
        #[arg(long)]
        goal: Option<String>,
        /// Status: planning, active, completed
        #[arg(long)]
        status: Option<String>,
    },
    /// Delete a cycle (unassigns all tasks)
    Delete {
        /// Cycle ID
        id: String,
    },
    /// Activate a planning cycle (planning → active). Required before tasks can be started.
    Activate {
        /// Cycle ID
        id: String,
    },
    /// Mark an active cycle as completed (active → completed). Cannot be restarted afterwards.
    Complete {
        /// Cycle ID
        id: String,
    },
    /// List tasks assigned to this cycle
    Tasks {
        /// Cycle ID
        id: String,
    },
    /// List backlog tasks (not assigned to any cycle) for a project
    Backlog {
        /// Project ID
        #[arg(long)]
        project: String,
    },
}

// ========== Task ==========
#[derive(Subcommand)]
enum TaskAction {
    /// Create a new task (atomic work unit). Unit and cycle are auto-inferred from the active plan/cycle if omitted.
    /// Status: todo → in_progress → done/cancelled. Blocked for external dependencies.
    Create {
        /// Task title describing the work
        title: String,
        /// Unit ID (auto-inferred from active plan if omitted)
        #[arg(long)]
        unit: Option<String>,
        /// Detailed description (markdown supported)
        #[arg(long, allow_hyphen_values = true)]
        body: Option<String>,
        /// Agent or person responsible (e.g. "main", "sub-agent-1")
        #[arg(long)]
        assignee: Option<String>,
        /// Sort order within unit
        #[arg(long)]
        idx: Option<i64>,
        /// Comma-separated task IDs this task depends on
        #[arg(long, value_delimiter = ',')]
        depends_on: Vec<String>,
        /// Parent task ID for sub-tasks
        #[arg(long)]
        parent_task: Option<String>,
        /// Priority: critical, high, medium, low
        #[arg(long, default_value = "medium")]
        priority: String,
        /// Complexity estimate (freeform, e.g. "high", "3 files")
        #[arg(long)]
        complexity: Option<String>,
        /// Estimated number of file edits
        #[arg(long)]
        estimated_edits: Option<i64>,
        /// Cycle ID. Auto-inferred from active cycle if omitted. Tasks without a cycle go to backlog.
        #[arg(long)]
        cycle: Option<String>,
        /// Task type: task, bug, feature, enhancement, refactor, docs, test, chore
        #[arg(long, default_value = "task")]
        r#type: String,
    },
    /// View task details by ID
    View {
        /// Task ID (TASK-ULID or ticket number like CK-285)
        id: String,
    },
    /// List tasks with optional filters
    List {
        /// Filter by unit ID
        #[arg(long)]
        unit_id: Option<String>,
        /// Filter by plan ID
        #[arg(long)]
        plan_id: Option<String>,
        /// Filter by status: todo, in_progress, blocked, done, cancelled
        #[arg(long)]
        status: Option<String>,
        /// Filter by Claude Code agent_id (from SubagentStart hook)
        #[arg(long)]
        agent_id: Option<String>,
    },
    /// Update task fields. Status values: todo, in_progress, blocked, done, cancelled. Pass empty string ("") to --cycle to detach (move to backlog).
    Update {
        /// Task ID (TASK-ULID or ticket number like CK-285)
        id: String,
        /// New task title
        #[arg(long)]
        title: Option<String>,
        /// Replace task body (markdown supported). Pass "" to clear.
        #[arg(long, allow_hyphen_values = true)]
        body: Option<String>,
        /// Status: todo, in_progress, blocked, done, cancelled
        #[arg(long)]
        status: Option<String>,
        /// Agent or person responsible
        #[arg(long)]
        assignee: Option<String>,
        #[arg(long, hide = true)]
        session_id: Option<String>,
        #[arg(long, default_value = "main", hide = true)]
        agent: String,
        /// Priority: critical, high, medium, low
        #[arg(long)]
        priority: Option<String>,
        /// Complexity estimate (freeform, e.g. "high", "3 files")
        #[arg(long)]
        complexity: Option<String>,
        /// Estimated number of file edits
        #[arg(long)]
        estimated_edits: Option<i64>,
        /// Parent task ID (for sub-tasks)
        #[arg(long)]
        parent_task: Option<String>,
        /// Cycle ID. Pass "" to detach and move task to backlog.
        #[arg(long)]
        cycle: Option<String>,
        /// Claude Code agent_id (from SubagentStart hook)
        #[arg(long, hide = true)]
        agent_id: Option<String>,
        /// Add a comment along with the update
        #[arg(long, allow_hyphen_values = true)]
        comment: Option<String>,
    },
    /// Delete a task (only allowed when its plan is still in draft)
    Delete {
        /// Task ID to delete
        id: String,
    },
    /// Append text to a task's body (does not replace existing content)
    AppendBody {
        /// Task ID
        id: String,
        /// Text to append to the body
        #[arg(long, allow_hyphen_values = true)]
        text: String,
    },
    /// Search tasks by keyword (FTS5) across title and body
    Search {
        /// Search query
        query: String,
        /// Maximum number of results
        #[arg(long, default_value = "20")]
        limit: u32,
    },
}

// ========== Artifact ==========
#[derive(Subcommand)]
enum ArtifactAction {
    /// Create a wiki artifact (document, decision, reference). Attach to at least one scope (task/unit/plan).
    Create {
        /// Artifact title
        title: String,
        /// Artifact type: doc, decision, reference, note, spec
        #[arg(long)]
        r#type: String,
        /// Attach to task ID
        #[arg(long)]
        task: Option<String>,
        /// Attach to unit ID
        #[arg(long)]
        unit: Option<String>,
        /// Attach to plan ID
        #[arg(long)]
        plan: Option<String>,
        /// Artifact content (markdown)
        #[arg(long, allow_hyphen_values = true)]
        content: Option<String>,
        /// Content format: md (default), txt, code
        #[arg(long, default_value = "md")]
        content_format: String,
        /// Parent artifact ID (for hierarchical wiki structure)
        #[arg(long)]
        parent: Option<String>,
    },
    /// View an artifact by ID
    View {
        /// Artifact ID
        id: String,
    },
    /// List artifacts with optional filters
    List {
        /// Filter by task ID
        #[arg(long)]
        task_id: Option<String>,
        /// Filter by unit ID
        #[arg(long)]
        unit_id: Option<String>,
        /// Filter by plan ID
        #[arg(long)]
        plan_id: Option<String>,
        /// Filter by type
        #[arg(long)]
        r#type: Option<String>,
    },
    /// Delete an artifact by ID
    Delete {
        /// Artifact ID
        id: String,
    },
    /// Search wiki artifacts (FTS5 + vector hybrid)
    Search {
        /// Search query
        query: String,
        /// Search mode: keyword | semantic | hybrid
        #[arg(long, default_value = "hybrid")]
        mode: String,
        /// Filter by scope: rag | reference | archive
        #[arg(long, default_value = "rag")]
        scope: String,
        /// Maximum number of results
        #[arg(long, default_value = "20")]
        limit: u32,
    },
    /// Import docs/ files as Artifacts
    Import {
        /// Working directory to scan docs/ from
        #[arg(long)]
        cwd: String,
        /// Attach imported artifacts to this plan
        #[arg(long)]
        plan_id: Option<String>,
        /// Attach imported artifacts to this unit
        #[arg(long)]
        unit_id: Option<String>,
        /// Scope for imported artifacts: rag | reference | archive
        #[arg(long, default_value = "reference")]
        scope: String,
        /// Preview without creating
        #[arg(long)]
        dry_run: bool,
    },
    /// Export Artifacts to docs/ directory
    Export {
        /// Target working directory (writes to <cwd>/docs/)
        #[arg(long)]
        cwd: String,
        /// Export only artifacts attached to this plan
        #[arg(long)]
        plan_id: Option<String>,
        /// Export only artifacts attached to this unit
        #[arg(long)]
        unit_id: Option<String>,
    },
}

// ========== Run ==========
#[derive(Subcommand)]
enum RunAction {
    /// Start a run record for a task (usually auto-created by hooks on task start)
    Start {
        /// Task ID to start a run for
        #[arg(long)]
        task: String,
        /// Claude Code session ID (internal, from hook)
        #[arg(long, hide = true)]
        session_id: Option<String>,
        /// Agent executing the run
        #[arg(long, default_value = "main")]
        agent: String,
    },
    /// Finish an active run with a result
    Finish {
        /// Run ID
        id: String,
        /// Result: success | failure | cancelled
        #[arg(long)]
        result: String,
        /// Free-form notes about the run outcome
        #[arg(long, allow_hyphen_values = true)]
        notes: Option<String>,
    },
    /// View run details by ID
    View {
        /// Run ID
        id: String,
    },
    /// List runs with optional filters
    List {
        /// Filter by task ID
        #[arg(long)]
        task_id: Option<String>,
        /// Filter by session ID
        #[arg(long, hide = true)]
        session_id: Option<String>,
    },
}

// ========== Question ==========
#[derive(Subcommand)]
enum QuestionAction {
    /// Create a question requesting human clarification or decision
    Create {
        /// Question body
        body: String,
        /// Attach to plan ID
        #[arg(long)]
        plan: Option<String>,
        /// Attach to unit ID
        #[arg(long)]
        unit: Option<String>,
        /// Attach to task ID
        #[arg(long)]
        task: Option<String>,
        /// Question kind: clarification | decision | blocker
        #[arg(long, default_value = "clarification")]
        kind: String,
        /// Origin of the question: prompt | plan | review
        #[arg(long, default_value = "prompt")]
        origin: String,
        /// Who asked the question
        #[arg(long, default_value = "main")]
        asked_by: String,
    },
    /// Answer an open question
    Answer {
        /// Question ID
        id: String,
        /// Answer text
        #[arg(long, allow_hyphen_values = true)]
        text: String,
        /// Who answered: human | main | <agent-name>
        #[arg(long, default_value = "human")]
        by: String,
    },
    /// View question details by ID
    View {
        /// Question ID
        id: String,
    },
    /// List questions with optional filters
    List {
        /// Filter by plan ID
        #[arg(long)]
        plan_id: Option<String>,
        /// Filter by unit ID
        #[arg(long)]
        unit_id: Option<String>,
        /// Filter by task ID
        #[arg(long)]
        task_id: Option<String>,
        /// If true, show only unanswered questions
        #[arg(long)]
        pending: Option<bool>,
    },
}

// ========== Comment ==========
#[derive(Subcommand)]
enum CommentAction {
    /// Add a comment to a task (used for progress notes, decisions, status change rationale)
    Create {
        /// Target task ID
        #[arg(long)]
        task: String,
        /// Comment body (markdown supported)
        #[arg(long, allow_hyphen_values = true)]
        body: String,
        /// Comment author (defaults to "main")
        #[arg(long, default_value = "main")]
        author: String,
    },
    /// List comments for a task
    List {
        /// Task ID
        #[arg(long)]
        task_id: String,
    },
    /// Delete a comment by ID
    Delete {
        /// Comment ID
        id: String,
    },
}

fn strip_nulls(val: &serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::Object(map) => {
            let filtered: serde_json::Map<String, serde_json::Value> = map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), strip_nulls(v)))
                .collect();
            serde_json::Value::Object(filtered)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(strip_nulls).collect())
        }
        other => other.clone(),
    }
}

fn output_fmt(val: &serde_json::Value, format: &str) {
    match format {
        "table" => print_table(val),
        "yaml" => print_yaml(val, 0),
        _ => println!("{}", serde_json::to_string(&strip_nulls(val)).unwrap()),
    }
}

fn print_table(val: &serde_json::Value) {
    match val {
        serde_json::Value::Array(arr) if !arr.is_empty() => {
            if let Some(first) = arr[0].as_object() {
                let keys: Vec<&String> = first.keys().collect();
                // Filter out long fields
                let visible: Vec<&&String> = keys.iter()
                    .filter(|k| !["body", "content", "depends_on"].contains(&k.as_str()))
                    .collect();
                let headers: Vec<&str> = visible.iter().map(|k| k.as_str()).collect();
                let rows: Vec<Vec<String>> = arr.iter().map(|item| {
                    visible.iter().map(|k| {
                        let v = item.get(k.as_str()).unwrap_or(&serde_json::Value::Null);
                        let s = match v {
                            serde_json::Value::Null => String::new(),
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Number(n) => n.to_string(),
                            serde_json::Value::Bool(b) => b.to_string(),
                            _ => serde_json::to_string(v).unwrap_or_default(),
                        };
                        if s.chars().count() > 50 {
                            let truncated: String = s.chars().take(47).collect();
                            format!("{}...", truncated)
                        } else { s }
                    }).collect()
                }).collect();
                // Compute widths (use Unicode display width for CJK chars)
                fn display_width(s: &str) -> usize {
                    s.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum()
                }
                fn pad_to_width(s: &str, target: usize) -> String {
                    let w = display_width(s);
                    if w >= target { s.to_string() } else { format!("{}{}", s, " ".repeat(target - w)) }
                }
                let widths: Vec<usize> = headers.iter().enumerate().map(|(i, h)| {
                    let max_row = rows.iter().map(|r| r.get(i).map_or(0, |c| display_width(c))).max().unwrap_or(0);
                    display_width(h).max(max_row)
                }).collect();
                let sep: String = format!("+{}+", widths.iter().map(|w| "-".repeat(w + 2)).collect::<Vec<_>>().join("+"));
                let fmt_row = |cells: &[String]| -> String {
                    format!("| {} |", cells.iter().enumerate().map(|(i, c)| pad_to_width(c, widths[i])).collect::<Vec<_>>().join(" | "))
                };
                println!("{}", sep);
                println!("{}", fmt_row(&headers.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
                println!("{}", sep);
                for row in &rows { println!("{}", fmt_row(row)); }
                println!("{}", sep);
            }
        }
        serde_json::Value::Object(obj) => {
            for (k, v) in obj {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Null => String::new(),
                    _ => serde_json::to_string(v).unwrap_or_default(),
                };
                println!("{}: {}", k, if s.len() > 80 { format!("{}...", &s[..77]) } else { s });
            }
        }
        _ => println!("{}", serde_json::to_string(val).unwrap()),
    }
}

fn print_yaml(val: &serde_json::Value, indent: usize) {
    let pad = "  ".repeat(indent);
    match val {
        serde_json::Value::Null => println!("{}null", pad),
        serde_json::Value::Bool(b) => println!("{}{}", pad, b),
        serde_json::Value::Number(n) => println!("{}{}", pad, n),
        serde_json::Value::String(s) => println!("{}{}", pad, s),
        serde_json::Value::Array(arr) => {
            for item in arr {
                print!("{}- ", pad);
                if item.is_object() {
                    println!();
                    print_yaml(item, indent + 1);
                } else {
                    let s = serde_json::to_string(item).unwrap_or_default();
                    println!("{}", s);
                }
            }
        }
        serde_json::Value::Object(obj) => {
            for (k, v) in obj {
                match v {
                    serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                        println!("{}{}:", pad, k);
                        print_yaml(v, indent + 1);
                    }
                    _ => {
                        let s = match v {
                            serde_json::Value::Null => "null".to_string(),
                            serde_json::Value::String(s) => s.clone(),
                            _ => serde_json::to_string(v).unwrap_or_default(),
                        };
                        println!("{}{}: {}", pad, k, s);
                    }
                }
            }
        }
    }
}

fn query_string(params: &[(&str, &Option<String>)]) -> String {
    let pairs: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|val| format!("{}={}", k, urlenc(val))))
        .collect();
    if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) }
}

fn urlenc(s: &str) -> String {
    s.replace('%', "%25")
        .replace(' ', "%20")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('#', "%23")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let fmt = cli.format.clone();
    let quiet = cli.quiet;

    match cli.command {
        Command::Daemon { action } => {
            return daemon::run(action).await;
        }
        _ => {}
    }

    let c = client::make_client();
    let output = |val: &serde_json::Value| {
        if quiet {
            // In quiet mode, just print the ID field if present
            if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                println!("{}", id);
            } else if let serde_json::Value::Array(arr) = val {
                for item in arr {
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        println!("{}", id);
                    }
                }
            }
        } else {
            output_fmt(val, &fmt);
        }
    };

    match cli.command {
        Command::Daemon { .. } => unreachable!(),

        Command::Dashboard { cwd, show } => {
            let cwd = cwd.unwrap_or_else(|| std::env::current_dir().unwrap().to_string_lossy().to_string());
            let qs = format!("?cwd={}&show={}", urlenc(&cwd), urlenc(&show));
            let val = client::get(&c, &format!("/dashboard{qs}")).await?;
            // Print the context string directly (not JSON) for hook injection
            if let Some(ctx) = val.get("context").and_then(|v| v.as_str()) {
                print!("{ctx}");
            }
        }

        // ===== Project =====
        Command::Project { action } => match action {
            ProjectAction::Create { name, description, cwd, key } => {
                let cwd = cwd.or_else(|| Some(std::env::current_dir().unwrap().to_string_lossy().to_string()));
                let val = client::request(&c, "POST", "/projects", Some(json!({
                    "name": name, "description": description, "cwd": cwd, "key": key
                }))).await?;
                output(&val);
            }
            ProjectAction::View { id } => output(&client::get(&c, &format!("/projects/{id}")).await?),
            ProjectAction::List => output(&client::get(&c, "/projects").await?),
            ProjectAction::Update { id, name, description, wiki_paths } => {
                let mut body = json!({});
                if let Some(v) = name { body["name"] = json!(v); }
                if let Some(v) = description { body["description"] = json!(v); }
                if let Some(v) = wiki_paths {
                    let parsed: serde_json::Value = serde_json::from_str(&v)
                        .unwrap_or_else(|_| json!([v]));
                    body["wiki_paths"] = parsed;
                }
                output(&client::request(&c, "PATCH", &format!("/projects/{id}"), Some(body)).await?);
            }
            ProjectAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/projects/{id}"), None).await?);
            }
            ProjectAction::Cwd { action } => match action {
                ProjectCwdAction::Add { id, path } => {
                    let cwd = path.unwrap_or_else(|| std::env::current_dir().unwrap().to_string_lossy().to_string());
                    output(&client::request(&c, "POST", &format!("/projects/{id}/cwds"), Some(json!({"cwd": cwd}))).await?);
                }
                ProjectCwdAction::Remove { id, path } => {
                    output(&client::request(&c, "DELETE", &format!("/projects/{id}/cwds"), Some(json!({"cwd": path}))).await?);
                }
                ProjectCwdAction::List { id } => {
                    let proj = client::get(&c, &format!("/projects/{id}")).await?;
                    if let Some(cwds) = proj.get("cwds") {
                        output(cwds);
                    } else {
                        output(&json!([]));
                    }
                }
            },
        },

        // ===== Plan =====
        Command::Plan { action } => match action {
            PlanAction::Create { title, project, description, source, source_path } => {
                output(&client::request(&c, "POST", "/plans", Some(json!({
                    "project_id": project, "title": title, "description": description,
                    "source": source, "source_path": source_path,
                }))).await?);
            }
            PlanAction::View { id } => output(&client::get(&c, &format!("/plans/{id}")).await?),
            PlanAction::List { project_id, status } => {
                let qs = query_string(&[("project_id", &project_id), ("status", &status)]);
                output(&client::get(&c, &format!("/plans{qs}")).await?);
            }
            PlanAction::Update { id, title, description, status } => {
                let mut body = json!({});
                if let Some(v) = title { body["title"] = json!(v); }
                if let Some(v) = description { body["description"] = json!(v); }
                if let Some(v) = status { body["status"] = json!(v); }
                output(&client::request(&c, "PATCH", &format!("/plans/{id}"), Some(body)).await?);
            }
            PlanAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/plans/{id}"), None).await?);
            }
            PlanAction::Approve { id } => {
                output(&client::request(&c, "POST", &format!("/plans/{id}/approve"), None).await?);
            }
            PlanAction::Complete { id } => {
                output(&client::request(&c, "PATCH", &format!("/plans/{id}"), Some(json!({"status": "completed"}))).await?);
            }
            PlanAction::Import { file, project, cwd, source, dry_run } => {
                output(&client::request(&c, "POST", "/plans/import", Some(json!({
                    "file": file, "project": project, "cwd": cwd, "source": source, "dryRun": dry_run,
                }))).await?);
            }
        },

        // ===== Unit =====
        Command::Unit { action } => match action {
            UnitAction::Create { title, plan, goal, idx, mode } => {
                if mode != "sequential" && mode != "parallel" {
                    eprintln!("Error: invalid value '{}' for '--mode'\n", mode);
                    eprintln!("  Valid values: sequential, parallel\n");
                    eprintln!("  sequential  Tasks execute one at a time (default)");
                    eprintln!("  parallel    Tasks can be executed by multiple agents simultaneously");
                    std::process::exit(1);
                }
                output(&client::request(&c, "POST", "/units", Some(json!({
                    "plan_id": plan, "title": title, "goal": goal, "idx": idx,
                    "execution_mode": mode,
                }))).await?);
            }
            UnitAction::View { id } => output(&client::get(&c, &format!("/units/{id}")).await?),
            UnitAction::List { plan_id } => {
                let qs = query_string(&[("plan_id", &plan_id)]);
                output(&client::get(&c, &format!("/units{qs}")).await?);
            }
            UnitAction::Update { id, title, goal, mode } => {
                let mut body = json!({});
                if let Some(v) = title { body["title"] = json!(v); }
                if let Some(v) = goal { body["goal"] = json!(v); }
                if let Some(ref v) = mode {
                    if v != "sequential" && v != "parallel" {
                        eprintln!("Error: invalid value '{}' for '--mode'\n", v);
                        eprintln!("  Valid values: sequential, parallel\n");
                        eprintln!("  sequential  Tasks execute one at a time");
                        eprintln!("  parallel    Tasks can be executed by multiple agents simultaneously");
                        std::process::exit(1);
                    }
                    body["execution_mode"] = json!(v);
                }
                output(&client::request(&c, "PATCH", &format!("/units/{id}"), Some(body)).await?);
            }
            UnitAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/units/{id}"), None).await?);
            }
        },

        // ===== Cycle =====
        Command::Cycle { action } => match action {
            CycleAction::Create { title, project, goal, idx } => {
                output(&client::request(&c, "POST", "/cycles", Some(json!({
                    "project_id": project, "title": title, "goal": goal, "idx": idx,
                }))).await?);
            }
            CycleAction::View { id } => output(&client::get(&c, &format!("/cycles/{id}")).await?),
            CycleAction::List { project_id, status } => {
                let qs = query_string(&[("project_id", &project_id), ("status", &status)]);
                output(&client::get(&c, &format!("/cycles{qs}")).await?);
            }
            CycleAction::Update { id, title, goal, status } => {
                let mut body = json!({});
                if let Some(v) = title { body["title"] = json!(v); }
                if let Some(v) = goal { body["goal"] = json!(v); }
                if let Some(v) = status { body["status"] = json!(v); }
                output(&client::request(&c, "PATCH", &format!("/cycles/{id}"), Some(body)).await?);
            }
            CycleAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/cycles/{id}"), None).await?);
            }
            CycleAction::Activate { id } => {
                output(&client::request(&c, "POST", &format!("/cycles/{id}/activate"), None).await?);
            }
            CycleAction::Complete { id } => {
                output(&client::request(&c, "PATCH", &format!("/cycles/{id}"), Some(json!({"status": "completed"}))).await?);
            }
            CycleAction::Tasks { id } => {
                output(&client::get(&c, &format!("/cycles/{id}/tasks")).await?);
            }
            CycleAction::Backlog { project } => {
                let qs = format!("?project_id={}", urlenc(&project));
                output(&client::get(&c, &format!("/backlog{qs}")).await?);
            }
        },

        // ===== Task =====
        Command::Task { action } => match action {
            TaskAction::Create { title, unit, body, assignee, idx, depends_on, parent_task, priority, complexity, estimated_edits, cycle, r#type } => {
                let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
                let type_val = r#type;
                output(&client::request(&c, "POST", "/tasks", Some(json!({
                    "unit_id": unit, "title": title, "body": body.unwrap_or_default(),
                    "assignee": assignee, "idx": idx, "depends_on": depends_on,
                    "parent_task_id": parent_task, "priority": priority,
                    "complexity": complexity, "estimated_edits": estimated_edits,
                    "cycle_id": cycle, "cwd": cwd, "type": type_val,
                }))).await?);
            }
            TaskAction::View { id } => output(&client::get(&c, &format!("/tasks/{id}")).await?),
            TaskAction::List { unit_id, plan_id, status, agent_id } => {
                let qs = query_string(&[("unit_id", &unit_id), ("plan_id", &plan_id), ("status", &status), ("agent_id", &agent_id)]);
                output(&client::get(&c, &format!("/tasks{qs}")).await?);
            }
            TaskAction::Update { id, title, body: task_body, status, assignee, session_id, agent, priority, complexity, estimated_edits, parent_task, cycle, agent_id, comment } => {
                let mut payload = json!({});
                if let Some(v) = title { payload["title"] = json!(v); }
                if let Some(v) = task_body { payload["body"] = json!(v); }
                if let Some(v) = status { payload["status"] = json!(v); }
                if let Some(ref v) = assignee { payload["assignee"] = json!(v); }
                if let Some(v) = session_id { payload["_session_id"] = json!(v); }
                payload["_agent"] = json!(agent);
                if let Some(v) = priority { payload["priority"] = json!(v); }
                if let Some(v) = complexity { payload["complexity"] = json!(v); }
                if let Some(v) = estimated_edits { payload["estimated_edits"] = json!(v); }
                if let Some(v) = parent_task { payload["parent_task_id"] = json!(v); }
                if let Some(v) = cycle { payload["cycle_id"] = json!(v); }
                if let Some(v) = agent_id { payload["agent_id"] = json!(v); }
                output(&client::request(&c, "PATCH", &format!("/tasks/{id}"), Some(payload)).await?);
                if let Some(text) = comment {
                    let author = assignee.as_deref().unwrap_or(&agent);
                    client::request(&c, "POST", &format!("/tasks/{id}/comments"), Some(json!({"task_id": id, "author": author, "body": text}))).await?;
                }
            }
            TaskAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/tasks/{id}"), None).await?);
            }
            TaskAction::AppendBody { id, text } => {
                output(&client::request(&c, "POST", &format!("/tasks/{id}/body"), Some(json!({"text": text}))).await?);
            }
            TaskAction::Search { query, limit } => {
                let qs = format!("?q={}&limit={limit}", urlenc(&query));
                output(&client::get(&c, &format!("/tasks/search{qs}")).await?);
            }
        },

        // ===== Artifact =====
        Command::Artifact { action } => match action {
            ArtifactAction::Create { title, r#type, task, unit, plan, content, content_format, parent } => {
                output(&client::request(&c, "POST", "/artifacts", Some(json!({
                    "type": r#type, "title": title, "task_id": task, "unit_id": unit,
                    "plan_id": plan, "content": content.unwrap_or_default(), "content_format": content_format,
                    "parent_id": parent,
                }))).await?);
            }
            ArtifactAction::View { id } => output(&client::get(&c, &format!("/artifacts/{id}")).await?),
            ArtifactAction::List { task_id, unit_id, plan_id, r#type } => {
                let type_opt = r#type;
                let qs = query_string(&[
                    ("task_id", &task_id), ("unit_id", &unit_id), ("plan_id", &plan_id), ("type", &type_opt)
                ]);
                output(&client::get(&c, &format!("/artifacts{qs}")).await?);
            }
            ArtifactAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/artifacts/{id}"), None).await?);
            }
            ArtifactAction::Search { query, mode, scope, limit } => {
                let qs = format!("?q={}&mode={}&scope={}&limit={}", urlenc(&query), mode, scope, limit);
                output(&client::get(&c, &format!("/artifacts/search{qs}")).await?);
            }
            ArtifactAction::Import { cwd, plan_id, unit_id, scope, dry_run } => {
                output(&client::request(&c, "POST", "/artifacts/import", Some(json!({
                    "cwd": cwd, "plan_id": plan_id, "unit_id": unit_id, "scope": scope, "dry_run": dry_run,
                }))).await?);
            }
            ArtifactAction::Export { cwd, plan_id, unit_id } => {
                output(&client::request(&c, "POST", "/artifacts/export", Some(json!({
                    "cwd": cwd, "plan_id": plan_id, "unit_id": unit_id,
                }))).await?);
            }
        },

        // ===== Run =====
        Command::Run { action } => match action {
            RunAction::Start { task, session_id, agent } => {
                output(&client::request(&c, "POST", "/runs", Some(json!({
                    "task_id": task, "session_id": session_id, "agent": agent,
                }))).await?);
            }
            RunAction::Finish { id, result, notes } => {
                output(&client::request(&c, "POST", &format!("/runs/{id}/finish"), Some(json!({
                    "result": result, "notes": notes,
                }))).await?);
            }
            RunAction::View { id } => output(&client::get(&c, &format!("/runs/{id}")).await?),
            RunAction::List { task_id, session_id } => {
                let qs = query_string(&[("task_id", &task_id), ("session_id", &session_id)]);
                output(&client::get(&c, &format!("/runs{qs}")).await?);
            }
        },

        // ===== Comment =====
        Command::Comment { action } => match action {
            CommentAction::Create { task, body, author } => {
                output(&client::request(&c, "POST", &format!("/tasks/{task}/comments"), Some(json!({
                    "author": author, "body": body,
                }))).await?);
            }
            CommentAction::List { task_id } => {
                output(&client::get(&c, &format!("/tasks/{task_id}/comments")).await?);
            }
            CommentAction::Delete { id } => {
                output(&client::request(&c, "DELETE", &format!("/comments/{id}"), None).await?);
            }
        },

        // ===== Question =====
        Command::Question { action } => match action {
            QuestionAction::Create { body, plan, unit, task, kind, origin, asked_by } => {
                output(&client::request(&c, "POST", "/questions", Some(json!({
                    "plan_id": plan, "unit_id": unit, "task_id": task,
                    "kind": kind, "origin": origin, "body": body, "asked_by": asked_by,
                }))).await?);
            }
            QuestionAction::Answer { id, text, by } => {
                output(&client::request(&c, "POST", &format!("/questions/{id}/answer"), Some(json!({
                    "answer": text, "answered_by": by,
                }))).await?);
            }
            QuestionAction::View { id } => output(&client::get(&c, &format!("/questions/{id}")).await?),
            QuestionAction::List { plan_id, unit_id, task_id, pending } => {
                let pending_str = pending.map(|b| b.to_string());
                let qs = query_string(&[
                    ("plan_id", &plan_id), ("unit_id", &unit_id), ("task_id", &task_id), ("pending", &pending_str)
                ]);
                output(&client::get(&c, &format!("/questions{qs}")).await?);
            }
        },
    }

    Ok(())
}
