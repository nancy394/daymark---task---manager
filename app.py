from __future__ import annotations

import functools
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import time
EMAIL_RE = re.compile(r"^[^@]+@[^@]+\.[^@]+$")

PASSWORD_ITERATIONS = 310_000
from datetime import date, datetime, time as day_time, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from uuid import uuid4
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    import tzdata
except ImportError:
    from zoneinfo import ZoneInfo
    class ZoneInfoNotFoundError(Exception):
        pass
from flask import Flask, g, jsonify, render_template, request, session


ROOT = Path(__file__).resolve().parent
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or os.environ.get("SESSION_SECRET"),
    DATABASE_PATH=os.environ.get("DAYMARK_DB_PATH", str(ROOT / "instance" / "daymark.sqlite3")),
    MAX_CONTENT_LENGTH=256 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)
 #if app.config["SECRET_KEY"] == "production":
 #  raise RuntimeError("SECRET_KEY must be set...")
PASSWORD_ITERATIONS = 310_000

DEFAULT_SETTINGS = {
    "sound": "chime",
    "notificationsEnabled": True,
    "dailyCapacityMinutes": 360,
    "energyWindow": "morning",
    "timezone": "UTC",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_stamp(value: datetime | None = None) -> str:
    return (value or utc_now()).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_stamp(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        path = Path(app.config["DATABASE_PATH"])
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_error=None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db() -> None:
    path = Path(app.config["DATABASE_PATH"])
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
    finally:
        conn.close()


def json_error(message: str, status: int):
    return jsonify({"error": message}), status


def body_object() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        computed = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        ).hex()
        return hmac.compare_digest(computed, digest_hex)
    except (ValueError, TypeError):
        return False


def normalize_email(value) -> str | None:
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    return email if len(email) <= 254 and EMAIL_RE.fullmatch(email) else None


def mail_is_configured() -> bool:
    return True
def send_verification_email(email: str, code: str) -> None:
    return True
def verification_hash(email: str, code: str) -> str:
    secret = (app.config.get("SECRET_KEY") or "").encode()
    return hmac.new(secret, f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def issue_verification(email: str):
    if not mail_is_configured():
        return json_error(
            "Email verification is not configured yet. Add the SMTP settings listed in the setup guide.",
            503,
        )
    now = time.time()
    existing = get_db().execute(
        "SELECT created_at FROM verification_codes WHERE email = ?", (email,)
    ).fetchone()
    if existing and now - existing["created_at"] < 60:
        return json_error("Wait a minute before requesting another code.", 429)

    code = f"{secrets.randbelow(1_000_000):06d}"
    get_db().execute(
        """
        INSERT INTO verification_codes (email, code_hash, expires_at, attempts, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(email) DO UPDATE SET
          code_hash = excluded.code_hash,
          expires_at = excluded.expires_at,
          attempts = 0,
          created_at = excluded.created_at
        """,
        (email, verification_hash(email, code), now + 600, now),
    )
    get_db().commit()
    try:
        send_verification_email(email, code)
    except (OSError, smtplib.SMTPException, RuntimeError, ValueError) as exc:
        get_db().execute("DELETE FROM verification_codes WHERE email = ?", (email,))
        get_db().commit()
        app.logger.error("Verification email could not be sent: %s", type(exc).__name__)
        return json_error("Daymark could not send the verification email. Check the SMTP settings.", 503)
    return jsonify({"message": "A verification code was sent to your email address."}), 202


def user_required(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return json_error("Sign in to continue.", 401)
        g.user_id = user_id
        return fn(*args, **kwargs)

    return wrapped


@app.before_request
def protect_mutations():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        expected = session.get("csrf_token")
        provided = request.headers.get("X-CSRF-Token", "")
        if not expected or not hmac.compare_digest(expected, provided):
            return json_error("This page expired. Refresh and try again.", 403)
    return None


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'none'",
    )
    return response


@app.errorhandler(413)
def request_too_large(_error):
    return json_error("That request is too large.", 413)


def ensure_settings(user_id: str) -> None:
    get_db().execute("INSERT OR IGNORE INTO settings (user_id,timezone) VALUES (?,'UTC')", [user_id])
    get_db().commit()


def user_zone(user_id: str) -> ZoneInfo:
    candidate = request.headers.get("X-Client-Timezone", "").strip()
    zone = None
    if candidate:
        try:
            zone = ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError):
            zone = None
        ensure_settings(user_id)
        row = get_db().execute("SELECT timezone FROM settings WHERE user_id = ?", [user_id]).fetchone()
    if zone is None:
        if row and row["timezone"]:
            try:
                zone = ZoneInfo(row["timezone"])
            except (ZoneInfoNotFoundError, ValueError):
                zone = ZoneInfo("UTC")
        else:
            zone = ZoneInfo("UTC")
    if row and row["timezone"] != zone.key:
        get_db().execute("UPDATE settings SET timezone = ? WHERE user_id = ?", [zone.key, user_id])
        get_db().commit()
    return zone


def local_today(user_id: str) -> date:
    return utc_now().astimezone(user_zone(user_id)).date()


def session_user_json():
    user_id = session.get("user_id")
    user = None
    if user_id:
        row = get_db().execute("SELECT id, email FROM users WHERE id = ?", (user_id,)).fetchone()
        if row:
            user = {"id": row["id"], "email": row["email"]}
        else:
            session.clear()
    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"user": user, "csrfToken": session["csrf_token"]})


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/auth/session")
def auth_session():
    return session_user_json()


@app.post("/api/auth/register")
def register():
    body = body_object()
    email = normalize_email(body.get("email"))
    password = body.get("password")
    if not email:
        return json_error("Enter a valid email address.", 400)
    if not isinstance(password, str) or len(password) < 8 or len(password) > 256:
        return json_error("Use a password between 8 and 256 characters.", 400)
    

    existing = get_db().execute("SELECT id, verified_at FROM users WHERE email = ?", (email,)).fetchone()
    if existing and existing["verified_at"]:
        return json_error("An account with that email already exists. Sign in instead.", 409)
    if existing:
        get_db().execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), existing["id"]),
        )
    else:
        get_db().execute(
            "INSERT INTO users (id, email, password_hash, verified_at, created_at) VALUES (?, ?, ?, NULL, ?)",
            (str(uuid4()), email, hash_password(password), utc_stamp()),
        )
        get_db().commit()
    # --- DIRECT LOGIN, NO CODE ---
    user_row = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    uid = user_row["id"] if user_row else ""
    session["user_id"] = uid
    return jsonify({"ok": True, "user": {"id": uid, "email": email}}), 200

@app.post("/api/auth/resend")
def resend_verification():
    email = normalize_email(body_object().get("email"))
    if not email:
        return json_error("Enter a valid email address.", 400)
    user = get_db().execute("SELECT verified_at FROM users WHERE email = ?", (email,)).fetchone()
    if not user or user["verified_at"]:
        return json_error("There is no pending account for that email.", 404)
    return issue_verification(email)


@app.post("/api/auth/verify")
def verify_email():
    body = body_object()
    email = normalize_email(body.get("email"))
    code = body.get("code")
    if not email or not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        return json_error("Enter the six-digit code from your email.", 400)
    row = get_db().execute(
        "SELECT * FROM verification_codes WHERE email = ?", (email,)
    ).fetchone()
    if not row:
        return json_error("Request a fresh verification code and try again.", 400)
    if row["expires_at"] < time.time():
        get_db().execute("DELETE FROM verification_codes WHERE email = ?", (email,))
        get_db().commit()
        return json_error("That code expired. Request a new one.", 400)
    if row["attempts"] >= 5:
        return json_error("Too many tries. Request a new code.", 429)
    if not hmac.compare_digest(row["code_hash"], verification_hash(email, code)):
        get_db().execute(
            "UPDATE verification_codes SET attempts = attempts + 1 WHERE email = ?", (email,)
        )
        get_db().commit()
        return json_error("That code did not match. Check it and try again.", 400)

    user = get_db().execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if not user:
        return json_error("This registration is no longer available. Sign up again.", 404)
    get_db().execute("UPDATE users SET verified_at = ? WHERE id = ?", (utc_stamp(), user["id"]))
    get_db().execute("DELETE FROM verification_codes WHERE email = ?", (email,))
    get_db().commit()
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"user": {"id": user["id"], "email": email}, "csrfToken": session["csrf_token"]})


@app.post("/api/auth/login")
def login():
    body = body_object()
    email = normalize_email(body.get("email"))
    password = body.get("password")
    if not email or not isinstance(password, str) or len(password) > 256:
        return json_error("Enter your email and password.", 400)
    user = get_db().execute(
        "SELECT id, email, password_hash, verified_at FROM users WHERE email = ?", (email,)
    ).fetchone()
    if not user or not verify_password(password, user["password_hash"]):
        return json_error("Email or password is incorrect.", 401)
    
    session.permanent = True
    session["user_id"] = user["id"]
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"user": {"id": user["id"], "email": user["email"]}, "csrfToken": session["csrf_token"]})


@app.post("/api/auth/logout")
@user_required
def logout():
    session.clear()
    return jsonify({"message": "Signed out."})


def task_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "priority": row["priority"],
        "projectId": row["project_id"],
        "dueDate": row["due_date"],
        "reminderAt": row["reminder_at"],
        "estimateMinutes": row["estimate_minutes"],
        "energyLevel": row["energy_level"],
        "preferredTime": row["preferred_time"],
        "recurrence": row["recurrence"],
        "tags": json.loads(row["tags_json"]),
        "subtasks": json.loads(row["subtasks_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def validate_task(data: dict, creating: bool = False) -> dict:
    fields = {
        "title": "title",
        "description": "description",
        "status": "status",
        "priority": "priority",
        "projectId": "project_id",
        "dueDate": "due_date",
        "reminderAt": "reminder_at",
        "estimateMinutes": "estimate_minutes",
        "energyLevel": "energy_level",
        "preferredTime": "preferred_time",
        "recurrence": "recurrence",
        "tags": "tags_json",
        "subtasks": "subtasks_json",
    }
    result = {}
    for incoming, column in fields.items():
        if incoming not in data:
            continue
        value = data[incoming]
        if incoming == "title":
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > 240:
                raise ValueError("Task titles must be between 1 and 240 characters.")
            value = value.strip()
        elif incoming == "description":
            if value is not None and not isinstance(value, str):
                raise ValueError("Description must be text.")
            value = value.strip()[:4000] if isinstance(value, str) else None
        elif incoming == "status" and (not isinstance(value, str) or value not in STATUSES):
            raise ValueError("Choose a valid task status.")
        elif incoming == "priority" and (not isinstance(value, str) or value not in PRIORITIES):
            raise ValueError("Choose a valid priority.")
        elif incoming == "projectId":
            if value is not None and not isinstance(value, str):
                raise ValueError("Choose a valid project.")
        elif incoming == "dueDate":
            if value in (None, ""):
                value = None
            else:
                try:
                    value = date.fromisoformat(value).isoformat()
                except (TypeError, ValueError):
                    raise ValueError("Choose a valid due date.")
        elif incoming == "reminderAt":
            if value in (None, ""):
                value = None
            elif not isinstance(value, str):
                raise ValueError("Choose a valid reminder time.")
            else:
                try:
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    value = utc_stamp(parsed.astimezone(timezone.utc))
                except ValueError:
                    raise ValueError("Choose a valid reminder time.")
        elif incoming == "estimateMinutes":
            if not isinstance(value, int) or isinstance(value, bool) or not 5 <= value <= 1440:
                raise ValueError("Estimate must be between 5 and 1,440 minutes.")
        elif incoming == "energyLevel" and (not isinstance(value, str) or value not in ENERGY_LEVELS):
            raise ValueError("Choose a valid energy level.")
        elif incoming == "preferredTime" and (not isinstance(value, str) or value not in TIME_BLOCKS):
            raise ValueError("Choose a valid time of day.")
        elif incoming == "recurrence" and (not isinstance(value, str) or value not in RECURRENCES):
            raise ValueError("Choose a valid repeat schedule.")
        elif incoming == "tags":
            if not isinstance(value, list) or len(value) > 20 or not all(isinstance(tag, str) for tag in value):
                raise ValueError("Tags must be a list of up to 20 text labels.")
            value = json.dumps([tag.strip()[:40] for tag in value if tag.strip()])
        elif incoming == "subtasks":
            if not isinstance(value, list) or len(value) > 40:
                raise ValueError("A task can have up to 40 subtasks.")
            clean = []
            for item in value:
                if not isinstance(item, dict) or not isinstance(item.get("title"), str):
                    raise ValueError("Each subtask needs a title.")
                title = item["title"].strip()
                if not title:
                    continue
                clean.append(
                    {
                        "id": str(item.get("id") or uuid4()),
                        "title": title[:160],
                        "done": bool(item.get("done", False)),
                    }
                )
            value = json.dumps(clean)
        result[column] = value

    if creating and "title" not in result:
        raise ValueError("Add a task title.")
    if creating:
        result.setdefault("description", None)
        result.setdefault("status", "todo")
        result.setdefault("priority", "medium")
        result.setdefault("project_id", None)
        result.setdefault("due_date", None)
        result.setdefault("reminder_at", None)
        result.setdefault("estimate_minutes", 30)
        result.setdefault("energy_level", "medium")
        result.setdefault("preferred_time", "anytime")
        result.setdefault("recurrence", "none")
        result.setdefault("tags_json", "[]")
        result.setdefault("subtasks_json", "[]")
    return result


def verify_project(user_id: str, project_id: str | None) -> bool:
    if project_id is None:
        return True
    return get_db().execute(
        "SELECT id FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)
    ).fetchone() is not None


def insert_task(user_id: str, values: dict) -> sqlite3.Row:
    now = utc_stamp()
    completed_at = now if values["status"] == "done" else None
    task_id = str(uuid4())
    get_db().execute(
        """
        INSERT INTO tasks (
          id, user_id, title, description, status, priority, project_id, due_date,
          reminder_at, estimate_minutes, energy_level, preferred_time, recurrence,
          tags_json, subtasks_json, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id, user_id, values["title"], values["description"], values["status"],
            values["priority"], values["project_id"], values["due_date"], values["reminder_at"],
            values["estimate_minutes"], values["energy_level"], values["preferred_time"],
            values["recurrence"], values["tags_json"], values["subtasks_json"], completed_at,
            now, now,
        ),
    )
    get_db().commit()
    return get_db().execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()


def next_repeat_date(day: date, rule: str) -> date:
    next_day = day + timedelta(days=1)
    if rule == "weekdays":
        while next_day.weekday() >= 5:
            next_day += timedelta(days=1)
    elif rule == "weekly":
        next_day = day + timedelta(days=7)
    return next_day


@app.route("/api/tasks", methods=["GET", "POST"])
@user_required
def tasks_collection():
    user_id = g.user_id
    if request.method == "GET":
        clauses = ["user_id = ?"]
        values: list = [user_id]
        status = request.args.get("status")
        project_id = request.args.get("projectId")
        if status and status != "all":
            if status not in STATUSES:
                return json_error("Choose a valid task status.", 400)
            clauses.append("status = ?")
            values.append(status)
        if project_id:
            clauses.append("project_id = ?")
            values.append(project_id)
        rows = get_db().execute(
            "SELECT * FROM tasks WHERE " + " AND ".join(clauses)
            + " ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, "
            + "due_date IS NULL, due_date ASC, created_at DESC",
            values,
        ).fetchall()
        return jsonify([task_json(row) for row in rows])

    try:
        values = validate_task(body_object(), creating=True)
    except ValueError as exc:
        return json_error(str(exc), 400)
    if not verify_project(user_id, values["project_id"]):
        return json_error("That project is not available.", 400)
    row = insert_task(user_id, values)
    return jsonify(task_json(row)), 201


@app.route("/api/tasks/<task_id>", methods=["PATCH", "DELETE"])
@user_required
def task_item(task_id: str):
    user_id = g.user_id
    existing = get_db().execute(
        "SELECT * FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)
    ).fetchone()
    if not existing:
        return json_error("Task not found.", 404)
    if request.method == "DELETE":
        get_db().execute("DELETE FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id))
        get_db().commit()
        return "", 204

    try:
        updates = validate_task(body_object())
    except ValueError as exc:
        return json_error(str(exc), 400)
    if not updates:
        return json_error("Choose at least one task field to update.", 400)
    if "project_id" in updates and not verify_project(user_id, updates["project_id"]):
        return json_error("That project is not available.", 400)

    assignments = [f"{column} = ?" for column in updates]
    parameters = list(updates.values())
    entering_done = updates.get("status") == "done" and existing["status"] != "done"
    leaving_done = updates.get("status") is not None and updates["status"] != "done"
    if entering_done:
        assignments.append("completed_at = ?")
        parameters.append(utc_stamp())
    elif leaving_done:
        assignments.append("completed_at = NULL")
    assignments.append("updated_at = ?")
    parameters.extend([utc_stamp(), task_id, user_id])
    get_db().execute(
        "UPDATE tasks SET " + ", ".join(assignments) + " WHERE id = ? AND user_id = ?",
        parameters,
    )
    get_db().commit()
    updated = get_db().execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()

    if entering_done and existing["recurrence"] != "none":
        zone = user_zone(user_id)
        base_day = date.fromisoformat(existing["due_date"]) if existing["due_date"] else utc_now().astimezone(zone).date()
        due = next_repeat_date(base_day, existing["recurrence"])
        reminder = parse_stamp(existing["reminder_at"])
        if reminder:
            reminder += due - base_day
        next_values = {
            "title": existing["title"],
            "description": existing["description"],
            "status": "todo",
            "priority": existing["priority"],
            "project_id": existing["project_id"],
            "due_date": due.isoformat(),
            "reminder_at": utc_stamp(reminder) if reminder else None,
            "estimate_minutes": existing["estimate_minutes"],
            "energy_level": existing["energy_level"],
            "preferred_time": existing["preferred_time"],
            "recurrence": existing["recurrence"],
            "tags_json": existing["tags_json"],
            "subtasks_json": json.dumps(
                [
                    {"id": str(uuid4()), "title": item["title"], "done": False}
                    for item in json.loads(existing["subtasks_json"])
                ]
            ),
        }
        insert_task(user_id, next_values)
    return jsonify(task_json(updated))


def project_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "color": row["color"],
        "createdAt": row["created_at"],
    }


@app.route("/api/projects", methods=["GET", "POST"])
@user_required
def projects_collection():
    user_id = g.user_id
    if request.method == "GET":
        rows = get_db().execute(
            "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at ASC", (user_id,)
        ).fetchall()
        return jsonify([project_json(row) for row in rows])
    body = body_object()
    name = body.get("name")
    description = body.get("description")
    color = body.get("color", "#6c9a7e")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
        return json_error("Project names must be between 1 and 100 characters.", 400)
    if description is not None and not isinstance(description, str):
        return json_error("Project description must be text.", 400)
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        return json_error("Choose a valid project color.", 400)
    project_id = str(uuid4())
    get_db().execute(
        "INSERT INTO projects (id, user_id, name, description, color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (project_id, user_id, name.strip(), description, color, utc_stamp()),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return jsonify(project_json(row)), 201


@app.route("/api/projects/<project_id>", methods=["PATCH", "DELETE"])
@user_required
def project_item(project_id: str):
    user_id = g.user_id
    existing = get_db().execute(
        "SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)
    ).fetchone()
    if not existing:
        return json_error("Project not found.", 404)
    if request.method == "DELETE":
        get_db().execute("UPDATE tasks SET project_id = NULL WHERE project_id = ? AND user_id = ?", (project_id, user_id))
        get_db().execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id))
        get_db().commit()
        return "", 204
    body = body_object()
    updates = {}
    if "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            return json_error("Project names must be between 1 and 100 characters.", 400)
        updates["name"] = name.strip()
    if "description" in body:
        if body["description"] is not None and not isinstance(body["description"], str):
            return json_error("Project description must be text.", 400)
        updates["description"] = body["description"]
    if "color" in body:
        color = body["color"]
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            return json_error("Choose a valid project color.", 400)
        updates["color"] = color
    if not updates:
        return json_error("Choose a project field to update.", 400)
    get_db().execute(
        "UPDATE projects SET " + ", ".join(f"{key} = ?" for key in updates)
        + " WHERE id = ? AND user_id = ?",
        [*updates.values(), project_id, user_id],
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return jsonify(project_json(row))


def habit_streak(dates: list[str], today: date) -> int:
    completed = {date.fromisoformat(value) for value in dates}
    cursor = today if today in completed else today - timedelta(days=1)
    streak = 0
    while cursor in completed:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def habit_json(row: sqlite3.Row, today: date) -> dict:
    dates = json.loads(row["completed_dates_json"])
    return {
        "id": row["id"],
        "name": row["name"],
        "targetPerWeek": row["target_per_week"],
        "completedDates": dates,
        "streak": habit_streak(dates, today),
        "createdAt": row["created_at"],
    }


@app.route("/api/habits", methods=["GET", "POST"])
@user_required
def habits_collection():
    user_id = g.user_id
    today = local_today(user_id)
    if request.method == "GET":
        rows = get_db().execute(
            "SELECT * FROM habits WHERE user_id = ? ORDER BY created_at ASC", (user_id,)
        ).fetchall()
        return jsonify([habit_json(row, today) for row in rows])
    body = body_object()
    name = body.get("name")
    target = body.get("targetPerWeek", 5)
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
        return json_error("Habit names must be between 1 and 100 characters.", 400)
    if not isinstance(target, int) or isinstance(target, bool) or not 1 <= target <= 7:
        return json_error("Weekly targets must be between 1 and 7.", 400)
    habit_id = str(uuid4())
    get_db().execute(
        """
        INSERT INTO habits (id, user_id, name, target_per_week, completed_dates_json, created_at)
        VALUES (?, ?, ?, ?, '[]', ?)
        """,
        (habit_id, user_id, name.strip(), target, utc_stamp()),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    return jsonify(habit_json(row, today)), 201


@app.route("/api/habits/<habit_id>", methods=["PATCH", "DELETE"])
@user_required
def habit_item(habit_id: str):
    user_id = g.user_id
    row = get_db().execute(
        "SELECT * FROM habits WHERE id = ? AND user_id = ?", (habit_id, user_id)
    ).fetchone()
    if not row:
        return json_error("Habit not found.", 404)
    if request.method == "DELETE":
        get_db().execute("DELETE FROM habits WHERE id = ? AND user_id = ?", (habit_id, user_id))
        get_db().commit()
        return "", 204
    body = body_object()
    updates = {}
    if "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            return json_error("Habit names must be between 1 and 100 characters.", 400)
        updates["name"] = name.strip()
    if "targetPerWeek" in body:
        target = body["targetPerWeek"]
        if not isinstance(target, int) or isinstance(target, bool) or not 1 <= target <= 7:
            return json_error("Weekly targets must be between 1 and 7.", 400)
        updates["target_per_week"] = target
    if not updates:
        return json_error("Choose a habit field to update.", 400)
    get_db().execute(
        "UPDATE habits SET " + ", ".join(f"{key} = ?" for key in updates)
        + " WHERE id = ? AND user_id = ?",
        [*updates.values(), habit_id, user_id],
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    return jsonify(habit_json(row, local_today(user_id)))


@app.post("/api/habits/<habit_id>/complete")
@user_required
def complete_habit(habit_id: str):
    user_id = g.user_id
    row = get_db().execute(
        "SELECT * FROM habits WHERE id = ? AND user_id = ?", (habit_id, user_id)
    ).fetchone()
    if not row:
        return json_error("Habit not found.", 404)
    today = local_today(user_id)
    dates = json.loads(row["completed_dates_json"])
    day = today.isoformat()
    if day not in dates:
        dates.append(day)
        dates = dates[-400:]
        get_db().execute(
            "UPDATE habits SET completed_dates_json = ? WHERE id = ? AND user_id = ?",
            (json.dumps(dates), habit_id, user_id),
        )
        get_db().commit()
        row = get_db().execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    return jsonify(habit_json(row, today))


def focus_json(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "durationMinutes": row["duration_minutes"],
        "completedAt": row["completed_at"],
    }


@app.route("/api/focus-sessions", methods=["GET", "POST"])
@user_required
def focus_sessions():
    user_id = g.user_id
    if request.method == "GET":
        rows = get_db().execute(
            "SELECT * FROM focus_sessions WHERE user_id = ? ORDER BY completed_at DESC LIMIT 40",
            (user_id,),
        ).fetchall()
        return jsonify([focus_json(row) for row in rows])
    body = body_object()
    duration = body.get("durationMinutes")
    task_id = body.get("taskId")
    if not isinstance(duration, int) or isinstance(duration, bool) or not 1 <= duration <= 240:
        return json_error("Focus sessions must be between 1 and 240 minutes.", 400)
    if task_id is not None and (
        not isinstance(task_id, str)
        or not get_db().execute("SELECT id FROM tasks WHERE id = ? AND user_id = ?", (task_id, user_id)).fetchone()
    ):
        return json_error("That task is not available.", 400)
    session_id = str(uuid4())
    get_db().execute(
        """
        INSERT INTO focus_sessions (id, user_id, task_id, duration_minutes, completed_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (session_id, user_id, task_id, duration, utc_stamp()),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM focus_sessions WHERE id = ?", (session_id,)).fetchone()
    return jsonify(focus_json(row)), 201


def settings_json(row: sqlite3.Row) -> dict:
    return {
        "sound": row["sound"],
        "notificationsEnabled": bool(row["notifications_enabled"]),
        "dailyCapacityMinutes": row["daily_capacity_minutes"],
        "energyWindow": row["energy_window"],
        "timezone": row["timezone"],
    }


@app.route("/api/settings", methods=["GET", "PUT"])
@user_required
def settings():
    user_id = g.user_id
    zone = user_zone(user_id)
    ensure_settings(user_id)
    if request.method == "GET":
        row = get_db().execute("SELECT * FROM settings WHERE user_id = ?", (user_id,)).fetchone()
        return jsonify(settings_json(row))
    body = body_object()
    sound = body.get("sound")
    enabled = body.get("notificationsEnabled")
    capacity = body.get("dailyCapacityMinutes")
    energy = body.get("energyWindow")
    if not isinstance(sound, str) or sound not in SOUNDS:
        return json_error("Choose one of the five reminder sounds.", 400)
    if not isinstance(enabled, bool):
        return json_error("Notification preference must be on or off.", 400)
    if not isinstance(capacity, int) or isinstance(capacity, bool) or not 60 <= capacity <= 960:
        return json_error("Daily capacity must be between 60 and 960 minutes.", 400)
    if not isinstance(energy, str) or energy not in {"morning", "afternoon", "evening"}:
        return json_error("Choose a valid energy window.", 400)
    get_db().execute(
        """
        UPDATE settings
        SET sound = ?, notifications_enabled = ?, daily_capacity_minutes = ?, energy_window = ?, timezone = ?
        WHERE user_id = ?
        """,
        (sound, int(enabled), capacity, energy, zone.key, user_id),
    )
    get_db().commit()
    row = get_db().execute("SELECT * FROM settings WHERE user_id = ?", (user_id,)).fetchone()
    return jsonify(settings_json(row))


@app.get("/api/dashboard")
@user_required
def dashboard():
    user_id = g.user_id
    zone = user_zone(user_id)
    today = utc_now().astimezone(zone).date()
    rows = get_db().execute("SELECT * FROM tasks WHERE user_id = ?", (user_id,)).fetchall()
    open_rows = [row for row in rows if row["status"] != "done"]
    today_count = sum(1 for row in open_rows if row["due_date"] == today.isoformat())
    overdue_count = sum(
        1 for row in open_rows if row["due_date"] and row["due_date"] < today.isoformat()
    )
    settings_row = get_db().execute(
        "SELECT * FROM settings WHERE user_id = ?", (user_id,)
    ).fetchone()
    if settings_row is None:
        ensure_settings(user_id)
        settings_row = get_db().execute(
            "SELECT * FROM settings WHERE user_id = ?", (user_id,)
        ).fetchone()
    priority_rank = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
    candidates = [
        row for row in open_rows
        if row["due_date"] is None or row["due_date"] <= today.isoformat()
    ]
    candidates.sort(
        key=lambda row: (
            priority_rank.get(row["priority"], 3),
            0 if row["preferred_time"] == settings_row["energy_window"] else
            1 if row["preferred_time"] == "anytime" else 2,
            0 if row["energy_level"] == "high" else 1,
            row["due_date"] or "9999-12-31",
        )
    )
    planned_minutes = sum(row["estimate_minutes"] for row in candidates[:5])
    completed = sum(1 for row in rows if row["status"] == "done")
    completed_today = 0
    week_start = today - timedelta(days=6)
    week_counts = {week_start + timedelta(days=i): 0 for i in range(7)}
    completed_rows = get_db().execute(
        "SELECT completed_at FROM tasks WHERE user_id = ? AND status = 'done' AND completed_at IS NOT NULL",
        (user_id,),
    ).fetchall()
    for row in completed_rows:
        finished = parse_stamp(row["completed_at"])
        if finished is None:
            continue
        local_day = finished.astimezone(zone).date()
        if local_day == today:
            completed_today += 1
        if local_day in week_counts:
            week_counts[local_day] += 1

    focus_rows = get_db().execute(
        "SELECT duration_minutes, completed_at FROM focus_sessions WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    focus_minutes = 0
    for row in focus_rows:
        finished = parse_stamp(row["completed_at"])
        if finished and finished.astimezone(zone).date() == today:
            focus_minutes += row["duration_minutes"]

    habit_rows = get_db().execute(
        "SELECT completed_dates_json FROM habits WHERE user_id = ?", (user_id,)
    ).fetchall()
    current_streak = max(
        (habit_streak(json.loads(row["completed_dates_json"]), today) for row in habit_rows),
        default=0,
    )
    return jsonify(
        {
            "totalCount": len(rows),
            "completedCount": completed,
            "completedTodayCount": completed_today,
            "dueTodayCount": today_count,
            "overdueCount": overdue_count,
            "completionRate": round(completed / len(rows) * 100) if rows else 0,
            "minutesPlanned": planned_minutes,
            "minutesCapacity": settings_row["daily_capacity_minutes"],
            "focusMinutesToday": focus_minutes,
            "currentStreak": current_streak,
            "weeklyActivity": [week_counts[week_start + timedelta(days=i)] for i in range(7)],
        }
    )


@app.cli.command("init-db")
def init_db_command():
    init_db()
    print("Daymark database initialized.")

if __name__ == "__main__":
    # if not app.config["SECRET_KEY"]:
    #     raise RuntimeError("Set SECRET_KEY before starting Daymark.")
    init_db()
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=os.environ.get("APP_ENV") != "production",
    )