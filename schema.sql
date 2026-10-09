PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    verified_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#6c9a7e',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    due_date TEXT,
    reminder_at TEXT,
    estimate_minutes INTEGER NOT NULL DEFAULT 30,
    energy_level TEXT NOT NULL DEFAULT 'medium',
    preferred_time TEXT NOT NULL DEFAULT 'anytime',
    recurrence TEXT NOT NULL DEFAULT 'none',
    tags_json TEXT NOT NULL DEFAULT '[]',
    subtasks_json TEXT NOT NULL DEFAULT '[]',
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_per_week INTEGER NOT NULL DEFAULT 5,
    completed_dates_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS focus_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id TEXT,
    duration_minutes INTEGER NOT NULL,
    completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sound TEXT NOT NULL DEFAULT 'chime',
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    daily_capacity_minutes INTEGER NOT NULL DEFAULT 360,
    energy_window TEXT NOT NULL DEFAULT 'morning',
    timezone TEXT NOT NULL DEFAULT 'UTC'
);

CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id);
CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id, due_date);
CREATE INDEX IF NOT EXISTS tasks_user_project_idx ON tasks(user_id, project_id);
CREATE INDEX IF NOT EXISTS habits_user_idx ON habits(user_id);
CREATE INDEX IF NOT EXISTS focus_user_completed_idx ON focus_sessions(user_id, completed_at);
