//! Opt-in reads for the overseer. Nothing here runs unless the user turns demo data off
//! and enables a source. Tokens stay in `overseer.json` (mode 0600) inside Hoku's data
//! folder, or in `CURSOR_API_KEY`, `GITHUB_TOKEN` / `GH_TOKEN`, and `HERMES_API_KEY` /
//! `API_SERVER_KEY`. Responses are reduced to short fields before they reach the webview.

use crate::models::{HubError, HubResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    #[serde(default = "yes")]
    demo: bool,
    #[serde(default = "yes")]
    cursor_on: bool,
    #[serde(default = "yes")]
    github_on: bool,
    #[serde(default = "yes")]
    hermes_on: bool,
    #[serde(default = "yes")]
    grok_on: bool,
    #[serde(default)]
    cursor_key: Option<String>,
    #[serde(default)]
    github_token: Option<String>,
    #[serde(default)]
    hermes_key: Option<String>,
    #[serde(default = "default_dash")]
    hermes_dashboard: String,
    #[serde(default = "default_api")]
    hermes_api: String,
    #[serde(default)]
    grok_feed: String,
}

fn yes() -> bool {
    true
}
fn default_dash() -> String {
    "http://127.0.0.1:9119".into()
}
fn default_api() -> String {
    "http://127.0.0.1:8642".into()
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            demo: true,
            cursor_on: true,
            github_on: true,
            hermes_on: true,
            grok_on: true,
            cursor_key: None,
            github_token: None,
            hermes_key: None,
            hermes_dashboard: default_dash(),
            hermes_api: default_api(),
            grok_feed: String::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub demo: bool,
    pub cursor_on: bool,
    pub github_on: bool,
    pub hermes_on: bool,
    pub grok_on: bool,
    pub cursor_configured: bool,
    pub github_configured: bool,
    pub hermes_configured: bool,
    pub hermes_dashboard: String,
    pub hermes_api: String,
    pub grok_feed: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBody {
    pub demo: bool,
    pub cursor_on: bool,
    pub github_on: bool,
    pub hermes_on: bool,
    pub grok_on: bool,
    pub hermes_dashboard: String,
    pub hermes_api: String,
    pub grok_feed: String,
    pub cursor_key: String,
    pub github_token: String,
    pub hermes_key: String,
    pub clear_cursor_key: bool,
    pub clear_github_token: bool,
    pub clear_hermes_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refresh {
    pub cursor_items: Vec<Value>,
    pub cursor_runs: Vec<Value>,
    pub cursor_error: Option<String>,
    pub cursor_skipped: bool,
    pub github_review: Vec<Value>,
    pub github_changes: Vec<Value>,
    pub github_failing: Vec<Value>,
    pub github_authored: Vec<Value>,
    pub github_issues: Vec<Value>,
    pub github_error: Option<String>,
    pub github_skipped: bool,
    pub hermes_sessions: Option<Value>,
    pub hermes_error: Option<String>,
    pub hermes_note: String,
    pub hermes_skipped: bool,
    pub hermes_dashboard: String,
    pub grok_text: Option<String>,
    pub grok_error: Option<String>,
    pub grok_note: String,
    pub grok_skipped: bool,
}

fn config_path(app: &tauri::AppHandle) -> HubResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| HubError::new("Hoku's data folder is unavailable."))?;
    std::fs::create_dir_all(&dir)
        .map_err(|_| HubError::new("Hoku's data folder could not be created."))?;
    Ok(dir.join("overseer.json"))
}

fn read_config(path: &Path) -> HubResult<FileConfig> {
    if !path.exists() {
        return Ok(FileConfig::default());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| HubError::new("Overseer settings could not be read."))?;
    serde_json::from_str(&text).map_err(|_| {
        HubError::new("Overseer settings could not be parsed and were left unchanged.")
    })
}

fn write_config(path: &Path, cfg: &FileConfig) -> HubResult<()> {
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|_| HubError::new("Overseer settings could not be saved."))?;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|_| HubError::new("Overseer settings could not be saved."))?;
    std::io::Write::write_all(&mut file, text.as_bytes())
        .map_err(|_| HubError::new("Overseer settings could not be saved."))?;
    Ok(())
}

fn secret(file: &Option<String>, env: &[&str]) -> Option<String> {
    if let Some(s) = file.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Some(s.to_string());
    }
    env.iter().find_map(|k| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

fn publish(cfg: &FileConfig) -> PublicConfig {
    PublicConfig {
        demo: cfg.demo,
        cursor_on: cfg.cursor_on,
        github_on: cfg.github_on,
        hermes_on: cfg.hermes_on,
        grok_on: cfg.grok_on,
        cursor_configured: secret(&cfg.cursor_key, &["CURSOR_API_KEY"]).is_some(),
        github_configured: secret(&cfg.github_token, &["GITHUB_TOKEN", "GH_TOKEN"]).is_some(),
        hermes_configured: secret(&cfg.hermes_key, &["HERMES_API_KEY", "API_SERVER_KEY"]).is_some(),
        hermes_dashboard: cfg.hermes_dashboard.clone(),
        hermes_api: cfg.hermes_api.clone(),
        grok_feed: cfg.grok_feed.clone(),
    }
}

fn apply_secret(slot: &mut Option<String>, incoming: &str, clear: bool) -> HubResult<()> {
    if clear {
        *slot = None;
        return Ok(());
    }
    let t = incoming.trim();
    if t.is_empty() {
        return Ok(());
    }
    if t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(HubError::new(
            "A token contained whitespace and was not saved.",
        ));
    }
    *slot = Some(t.to_string());
    Ok(())
}

#[tauri::command]
pub fn overseer_config(app: tauri::AppHandle) -> HubResult<PublicConfig> {
    Ok(publish(&read_config(&config_path(&app)?)?))
}

#[tauri::command]
pub fn overseer_save(app: tauri::AppHandle, body: SaveBody) -> HubResult<PublicConfig> {
    let path = config_path(&app)?;
    let mut cfg = read_config(&path)?;
    let dash = body
        .hermes_dashboard
        .trim()
        .trim_end_matches('/')
        .to_string();
    let api = body.hermes_api.trim().trim_end_matches('/').to_string();
    if !loopback_origin(&dash) || !loopback_origin(&api) {
        return Err(HubError::new(
            "Hermes addresses have to be http://127.0.0.1 or http://localhost with a port.",
        ));
    }
    if !feed_path_ok(&body.grok_feed) {
        return Err(HubError::new("The Grok feed path cannot contain '..'."));
    }
    cfg.demo = body.demo;
    cfg.cursor_on = body.cursor_on;
    cfg.github_on = body.github_on;
    cfg.hermes_on = body.hermes_on;
    cfg.grok_on = body.grok_on;
    cfg.hermes_dashboard = dash;
    cfg.hermes_api = api;
    cfg.grok_feed = body.grok_feed.trim().to_string();
    apply_secret(&mut cfg.cursor_key, &body.cursor_key, body.clear_cursor_key)?;
    apply_secret(
        &mut cfg.github_token,
        &body.github_token,
        body.clear_github_token,
    )?;
    apply_secret(&mut cfg.hermes_key, &body.hermes_key, body.clear_hermes_key)?;
    write_config(&path, &cfg)?;
    Ok(publish(&cfg))
}

#[tauri::command]
pub async fn overseer_refresh(app: tauri::AppHandle) -> HubResult<Refresh> {
    let path = config_path(&app)?;
    let cfg = read_config(&path)?;
    if cfg.demo {
        return Err(HubError::new(
            "Demo data is on, so Hoku did not contact any source.",
        ));
    }
    let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
    tauri::async_runtime::spawn_blocking(move || Ok(fetch(cfg, dir)))
        .await
        .map_err(|e| HubError::with_detail("A background task failed.", e))?
}

#[tauri::command]
pub fn overseer_open(url: String, kind: String) -> HubResult<()> {
    if !front_url_allowed(&url, &kind) {
        return Err(HubError::new("That link is not one Hoku will open."));
    }
    crate::platform::open_url(&url)
        .map_err(|e| HubError::with_detail("The link could not be opened.", e))
}

fn fetch(cfg: FileConfig, data_dir: PathBuf) -> Refresh {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirects(0)
        .build();
    let (cursor_items, cursor_runs, cursor_error, cursor_skipped) = fetch_cursor(&agent, &cfg);
    let (github, github_error, github_skipped) = fetch_github(&agent, &cfg);
    let hermes = fetch_hermes(&agent, &cfg);
    let grok = fetch_grok(&cfg, &data_dir);
    Refresh {
        cursor_items,
        cursor_runs,
        cursor_error,
        cursor_skipped,
        github_review: github.0,
        github_changes: github.1,
        github_failing: github.2,
        github_authored: github.3,
        github_issues: github.4,
        github_error,
        github_skipped,
        hermes_sessions: hermes.0,
        hermes_error: hermes.1,
        hermes_note: hermes.2,
        hermes_skipped: !cfg.hermes_on,
        hermes_dashboard: cfg.hermes_dashboard,
        grok_text: grok.0,
        grok_error: grok.1,
        grok_note: grok.2,
        grok_skipped: !cfg.grok_on,
    }
}

fn fetch_cursor(
    agent: &ureq::Agent,
    cfg: &FileConfig,
) -> (Vec<Value>, Vec<Value>, Option<String>, bool) {
    if !cfg.cursor_on {
        return (vec![], vec![], None, true);
    }
    let Some(key) = secret(&cfg.cursor_key, &["CURSOR_API_KEY"]) else {
        return (vec![], vec![], Some("No Cursor API key.".into()), false);
    };
    if let Err(e) = usable(&key) {
        return (vec![], vec![], Some(e), false);
    }
    let auth = format!("Bearer {key}");
    let body = match get(
        agent,
        "https://api.cursor.com/v1/agents?limit=20&includeArchived=false",
        &[("Authorization", &auth), ("Accept", "application/json")],
    ) {
        Ok(b) => b,
        Err(e) => return (vec![], vec![], Some(explain("Cursor", e)), false),
    };
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                vec![],
                vec![],
                Some("Cursor returned data that was not JSON.".into()),
                false,
            )
        }
    };
    let items = parsed
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut slim = Vec::new();
    let mut runs = Vec::new();
    for item in items.iter().take(20) {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if !safe_id(id) || item.get("status").and_then(|v| v.as_str()) == Some("ARCHIVED") {
            continue;
        }
        slim.push(pick(
            item,
            &["id", "name", "status", "url", "updatedAt", "latestRunId"],
        ));
        if runs.len() >= 10 {
            continue;
        }
        let run_id = item
            .get("latestRunId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !safe_id(run_id) {
            continue;
        }
        let url = format!("https://api.cursor.com/v1/agents/{id}/runs/{run_id}");
        if let Ok(text) = get(
            agent,
            &url,
            &[("Authorization", &auth), ("Accept", "application/json")],
        ) {
            if let Ok(run) = serde_json::from_str::<Value>(&text) {
                runs.push(slim_run(&run));
            }
        }
    }
    (slim, runs, None, false)
}

fn fetch_github(
    agent: &ureq::Agent,
    cfg: &FileConfig,
) -> (
    (Vec<Value>, Vec<Value>, Vec<Value>, Vec<Value>, Vec<Value>),
    Option<String>,
    bool,
) {
    let empty = (vec![], vec![], vec![], vec![], vec![]);
    if !cfg.github_on {
        return (empty, None, true);
    }
    let Some(token) = secret(&cfg.github_token, &["GITHUB_TOKEN", "GH_TOKEN"]) else {
        return (empty, Some("No GitHub token.".into()), false);
    };
    if let Err(e) = usable(&token) {
        return (empty, Some(e), false);
    }
    let queries = [
        "is:open is:pr review-requested:@me",
        "is:open is:pr author:@me review:changes_requested",
        "is:open is:pr author:@me status:failure",
        "is:open is:pr author:@me",
        "is:open is:issue assignee:@me",
    ];
    let mut out = empty;
    let slots = [&mut out.0, &mut out.1, &mut out.2, &mut out.3, &mut out.4];
    for (q, slot) in queries.iter().zip(slots) {
        match gh_search(agent, &token, q) {
            Ok(items) => *slot = items,
            Err(e) => {
                return (
                    (vec![], vec![], vec![], vec![], vec![]),
                    Some(explain("GitHub", e)),
                    false,
                )
            }
        }
    }
    (out, None, false)
}

fn gh_search(agent: &ureq::Agent, token: &str, q: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://api.github.com/search/issues?per_page=15&q={}",
        form_encode(q)
    );
    let auth = format!("Bearer {token}");
    let body = get(
        agent,
        &url,
        &[
            ("Authorization", &auth),
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
        ],
    )?;
    let parsed: Value = serde_json::from_str(&body).map_err(|_| "not JSON".to_string())?;
    let items = parsed
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .take(15)
        .map(|item| {
            pick(
                &item,
                &["title", "html_url", "updated_at", "repository_url", "draft"],
            )
        })
        .collect())
}

fn fetch_hermes(agent: &ureq::Agent, cfg: &FileConfig) -> (Option<Value>, Option<String>, String) {
    if !cfg.hermes_on {
        return (None, None, String::new());
    }
    if !loopback_origin(&cfg.hermes_dashboard) {
        return (
            None,
            Some("The Hermes dashboard address is not a loopback URL.".into()),
            String::new(),
        );
    }
    let status_url = format!("{}/api/status", cfg.hermes_dashboard);
    if let Err(e) = get(agent, &status_url, &[]) {
        return (
            None,
            Some(explain("Hermes", e).replace("could not be reached", "is not running")),
            String::new(),
        );
    }
    let sessions_url = format!("{}/api/sessions?limit=20", cfg.hermes_dashboard);
    match get(agent, &sessions_url, &[]) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => (
                Some(project_sessions(&v)),
                None,
                "Sessions from the local dashboard. A needs-you state is set only when a session says it is waiting on approval or a clarification.".into(),
            ),
            Err(_) => (None, Some("Hermes returned a session list that was not JSON.".into()), String::new()),
        },
        Err(e) if e == "HTTP 401" || e == "HTTP 403" => fetch_hermes_api(agent, cfg),
        Err(e) => (None, Some(explain("Hermes", e)), String::new()),
    }
}

fn fetch_hermes_api(
    agent: &ureq::Agent,
    cfg: &FileConfig,
) -> (Option<Value>, Option<String>, String) {
    let Some(key) = secret(&cfg.hermes_key, &["HERMES_API_KEY", "API_SERVER_KEY"]) else {
        return (
            None,
            Some("The Hermes dashboard is running, but the session list requires a login. Hoku does not sign in.".into()),
            String::new(),
        );
    };
    if !loopback_origin(&cfg.hermes_api) {
        return (
            None,
            Some("The Hermes API address is not a loopback URL.".into()),
            String::new(),
        );
    }
    if let Err(e) = usable(&key) {
        return (None, Some(e), String::new());
    }
    let auth = format!("Bearer {key}");
    let url = format!("{}/api/sessions?limit=20", cfg.hermes_api);
    match get(agent, &url, &[("Authorization", &auth)]) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => (
                Some(project_sessions(&v)),
                None,
                "Sessions from the local API server. Hoku does not call the approval or clarify endpoints.".into(),
            ),
            Err(_) => (None, Some("Hermes returned a session list that was not JSON.".into()), String::new()),
        },
        Err(e) => (None, Some(explain("Hermes", e)), String::new()),
    }
}

fn fetch_grok(cfg: &FileConfig, data_dir: &Path) -> (Option<String>, Option<String>, String) {
    if !cfg.grok_on {
        return (None, None, String::new());
    }
    let path = if cfg.grok_feed.trim().is_empty() {
        data_dir.join("grok-bots.jsonl")
    } else {
        PathBuf::from(cfg.grok_feed.trim())
    };
    if !cfg.grok_feed.trim().is_empty() && !path.is_absolute() {
        return (
            None,
            Some("The Grok feed path has to be absolute.".into()),
            String::new(),
        );
    }
    if !path.is_file() {
        return (
            None,
            Some("The Grok feed file is not there yet.".into()),
            String::new(),
        );
    }
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
            return (
                None,
                Some("The Grok feed file could not be read.".into()),
                String::new(),
            )
        }
    };
    let mut buf = Vec::new();
    if file.take(256 * 1024).read_to_end(&mut buf).is_err() {
        return (
            None,
            Some("The Grok feed file could not be read.".into()),
            String::new(),
        );
    }
    let text = match String::from_utf8(buf) {
        Ok(t) => t,
        Err(_) => {
            return (
                None,
                Some("The Grok feed file is not UTF-8.".into()),
                String::new(),
            )
        }
    };
    (Some(text), None, "Read from the local feed. There is no public Grok Bot list API. Lines that do not match the format are skipped.".into())
}

fn get(agent: &ureq::Agent, url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    if !fetch_url_allowed(url) {
        return Err("refused".into());
    }
    let mut req = agent.get(url).set("User-Agent", "hoku-overseer");
    for (k, v) in headers {
        req = req.set(k, v);
    }
    match req.call() {
        Ok(resp) => read_body(resp),
        Err(ureq::Error::Status(code, resp)) => {
            let _ = read_body(resp);
            Err(format!("HTTP {code}"))
        }
        Err(ureq::Error::Transport(t)) => {
            let msg = t.to_string().to_lowercase();
            Err(if msg.contains("timed") {
                "timed out".into()
            } else {
                "could not be reached".into()
            })
        }
    }
}

fn read_body(resp: ureq::Response) -> Result<String, String> {
    let mut buf = Vec::new();
    resp.into_reader()
        .take(400_000)
        .read_to_end(&mut buf)
        .map_err(|_| "could not be reached".to_string())?;
    String::from_utf8(buf).map_err(|_| "not text".to_string())
}

fn explain(source: &str, err: String) -> String {
    match err.as_str() {
        "timed out" => format!("{source} timed out."),
        "could not be reached" => format!("{source} could not be reached."),
        "HTTP 401" | "HTTP 403" => format!("{source} rejected the credentials."),
        "not JSON" => format!("{source} returned data that was not JSON."),
        "refused" => format!("{source} URL was refused."),
        other => format!("{source} returned {other}."),
    }
}

fn usable(key: &str) -> Result<(), String> {
    if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        Err("The saved credential contains whitespace and was not sent.".into())
    } else {
        Ok(())
    }
}

fn pick(v: &Value, keys: &[&str]) -> Value {
    let mut m = serde_json::Map::new();
    let Some(obj) = v.as_object() else {
        return Value::Object(m);
    };
    for k in keys {
        if let Some(val) = obj.get(*k) {
            if let Some(s) = val.as_str() {
                m.insert((*k).to_string(), Value::String(clip_chars(s, 200)));
            } else if val.is_boolean() || val.is_number() {
                m.insert((*k).to_string(), val.clone());
            }
        }
    }
    Value::Object(m)
}

fn slim_run(run: &Value) -> Value {
    let mut branches = Vec::new();
    if let Some(arr) = run.pointer("/git/branches").and_then(|v| v.as_array()) {
        for b in arr.iter().take(4) {
            branches.push(json!({
                "repoUrl": clip_val(b.get("repoUrl"), 200),
                "prUrl": clip_val(b.get("prUrl"), 200),
            }));
        }
    }
    json!({
        "id": clip_val(run.get("id"), 128),
        "agentId": clip_val(run.get("agentId"), 128),
        "status": clip_val(run.get("status"), 40),
        "updatedAt": clip_val(run.get("updatedAt"), 40),
        "result": clip_val(run.get("result"), 160),
        "git": { "branches": branches },
    })
}

fn project_sessions(v: &Value) -> Value {
    let list = v
        .get("sessions")
        .and_then(|s| s.as_array())
        .cloned()
        .or_else(|| v.as_array().cloned())
        .unwrap_or_default();
    let sessions: Vec<Value> = list
        .iter()
        .take(30)
        .filter_map(|row| project_session(row))
        .collect();
    json!({ "sessions": sessions })
}

fn project_session(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut m = serde_json::Map::new();
    for k in ["id", "title", "preview", "status", "source"] {
        if let Some(s) = o.get(k).and_then(|x| x.as_str()) {
            let n = if k == "preview" { 160 } else { 120 };
            m.insert(k.into(), Value::String(clip_chars(s, n)));
        }
    }
    for k in ["is_active", "pending_approval", "pending_clarify"] {
        if let Some(b) = o.get(k).and_then(|x| x.as_bool()) {
            m.insert(k.into(), Value::Bool(b));
        }
    }
    if let Some(n) = o.get("last_active").and_then(|x| x.as_i64()) {
        m.insert("last_active".into(), json!(n));
    } else if let Some(s) = o.get("last_active").and_then(|x| x.as_str()) {
        m.insert("last_active".into(), Value::String(clip_chars(s, 40)));
    }
    if let Some(s) = o.get("ended_at").and_then(|x| x.as_str()) {
        m.insert("ended_at".into(), Value::String(clip_chars(s, 40)));
    } else if let Some(n) = o.get("ended_at").and_then(|x| x.as_i64()) {
        m.insert("ended_at".into(), json!(n));
    }
    m.get("id")?;
    Some(Value::Object(m))
}

fn clip_val(v: Option<&Value>, n: usize) -> Value {
    match v.and_then(|v| v.as_str()) {
        Some(s) => Value::String(clip_chars(s, n)),
        None => Value::Null,
    }
}

fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

fn safe_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Hosts Hoku is willing to contact. Hermes is loopback only. Redirects are off.
fn fetch_url_allowed(url: &str) -> bool {
    if url.starts_with("https://api.cursor.com/") || url.starts_with("https://api.github.com/") {
        return !url.contains('@');
    }
    hermes_http(url)
}

pub fn front_url_allowed(url: &str, kind: &str) -> bool {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) || url.contains('@') {
        return false;
    }
    match kind {
        "cloud-agent" => url.starts_with("https://cursor.com/agents/"),
        "github-pr" | "github-issue" => url.starts_with("https://github.com/"),
        "hermes" => hermes_http(url),
        "grok-bot" => url.starts_with("https://grok.com/"),
        _ => false,
    }
}

fn hermes_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    if rest.contains('@') {
        return false;
    }
    let hostport = rest.split('/').next().unwrap_or("");
    let Some((host, port)) = hostport.rsplit_once(':') else {
        return false;
    };
    (host == "127.0.0.1" || host == "localhost")
        && matches!(port.parse::<u16>(), Ok(p) if (1..).contains(&p))
}

fn loopback_origin(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    if rest.contains('/') || rest.contains('@') {
        return false;
    }
    let Some((host, port)) = rest.rsplit_once(':') else {
        return false;
    };
    (host == "127.0.0.1" || host == "localhost") && matches!(port.parse::<u16>(), Ok(p) if p > 0)
}

fn feed_path_ok(p: &str) -> bool {
    let t = p.trim();
    !t.contains('\0') && !t.split(['/', '\\']).any(|s| s == "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_links_stay_on_the_allowlist() {
        assert!(front_url_allowed(
            "https://cursor.com/agents/bc-demo-pagination",
            "cloud-agent"
        ));
        assert!(front_url_allowed(
            "https://github.com/hoku-demo/lumen/pull/18",
            "github-pr"
        ));
        assert!(front_url_allowed("http://127.0.0.1:9119/", "hermes"));
        assert!(front_url_allowed(
            "https://grok.com/chat/demo-release-notes",
            "grok-bot"
        ));
        assert!(!front_url_allowed("file:///etc/passwd", "github-pr"));
        assert!(!front_url_allowed(
            "https://user:secret@github.com/hoku-demo/lumen",
            "github-pr"
        ));
        assert!(!front_url_allowed(
            "https://github.com/hoku-demo/lumen/pull/18",
            "cloud-agent"
        ));
        assert!(!front_url_allowed("https://example.com/phish", "grok-bot"));
        assert!(!front_url_allowed("http://127.0.0.1:9119/", "github-pr"));
    }

    #[test]
    fn fetches_only_cursor_github_and_loopback() {
        assert!(fetch_url_allowed(
            "https://api.cursor.com/v1/agents?limit=20"
        ));
        assert!(fetch_url_allowed(
            "https://api.github.com/search/issues?q=x"
        ));
        assert!(fetch_url_allowed("http://127.0.0.1:9119/api/status"));
        assert!(fetch_url_allowed("http://localhost:8642/api/sessions"));
        assert!(!fetch_url_allowed("https://api.cursor.com.evil/v1/agents"));
        assert!(!fetch_url_allowed("http://169.254.169.254/latest"));
        assert!(!fetch_url_allowed("https://example.com/"));
        assert!(loopback_origin("http://127.0.0.1:9119"));
        assert!(!loopback_origin("http://127.0.0.1:9119/api"));
        assert!(!loopback_origin("https://127.0.0.1:9119"));
    }

    #[test]
    fn feed_paths_reject_parent_segments() {
        assert!(feed_path_ok(""));
        assert!(feed_path_ok("/tmp/grok-bots.jsonl"));
        assert!(!feed_path_ok("/tmp/../etc/passwd"));
    }
}
