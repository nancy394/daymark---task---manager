"use strict";

const root = document.getElementById("app");
const toastRegion = document.getElementById("toast-region");
const SOUND_NAMES = {
  chime: "Chime",
  double_ping: "Double ping",
  digital: "Digital",
  warm_bell: "Warm bell",
  rising: "Rising",
};
const STATUS_NAMES = { todo: "To do", in_progress: "In progress", done: "Done" };
const PRIORITY_NAMES = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
const PAGE_NAMES = {
  today: "Today",
  tasks: "Tasks",
  projects: "Projects",
  habits: "Habits",
  focus: "Focus",
  settings: "Settings",
};
const PAGE_ICONS = { today: "◷", tasks: "☷", projects: "▧", habits: "✳", focus: "◉", settings: "⚙" };
const state = {
  user: null,
  csrfToken: "",
  authMode: "login",
  pendingEmail: "",
  page: "today",
  taskView: "list",
  taskStatusFilter: "all",
  taskSearch: "",
  tasks: [],
  projects: [],
  habits: [],
  settings: null,
  focusSessions: [],
  timerMinutes: 25,
  timerRemaining: 25 * 60,
  timerStartedAt: 0,
  timerRunning: false,
  timerInterval: null,
  timerTaskId: "",
  timerRecorded: false,
  reminderInterval: null,
  reminded: new Set(),
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function localDateISO(value = new Date()) {
  const dateValue = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dateValue.getTime())) return "";
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function humanDate(value, options = { month: "short", day: "numeric" }) {
  if (!value) return "No date";
  const dateValue = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(dateValue.getTime())) return value;
  if (value.slice(0, 10) === localDateISO()) return "Today";
  if (value.slice(0, 10) === localDateISO(new Date(Date.now() + 86400000))) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, options).format(dateValue);
}

function fullDateLabel() {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
}

function timezoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function initials(email) {
  return (email || "D").trim().charAt(0).toUpperCase();
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), 3800);
}

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  headers.set("X-Client-Timezone", timezoneName());
  if (method !== "GET" && method !== "HEAD") {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return result;
}

async function refreshSession() {
  const result = await api("/api/auth/session");
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  if (state.user) {
    const key = `daymark-reminded-${state.user.id}`;
    try { state.reminded = new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { state.reminded = new Set(); }
  }
  return state.user;
}

function setAuthMode(mode, email = "") {
  state.authMode = mode;
  if (email) state.pendingEmail = email;
  render();
}

function setPage(page) {
  if (!PAGE_NAMES[page]) page = "today";
  state.page = page;
  history.replaceState(null, "", `#${page}`);
  render();
}

function render() {
  root.setAttribute("aria-busy", "true");
  if (!state.user) {
    renderAuth();
    root.setAttribute("aria-busy", "false");
    return;
  }
  renderShell();
  renderCurrentPage().catch((error) => {
    const content = document.getElementById("page-content");
    if (content) content.innerHTML = `<div class="card empty-state"><div class="empty-icon">!</div><h3>Daymark could not load this page</h3><p>${escapeHtml(error.message)}</p><button class="btn btn-quiet" data-action="retry-page">Try again</button></div>`;
  }).finally(() => root.setAttribute("aria-busy", "false"));
  startReminderChecks();
}

function renderAuth() {
  const mode = state.authMode;
  const isVerify = false;
  const isRegister = mode === "register";
  const title = isVerify ? "Check your inbox" : isRegister ? "Create your account" : "Welcome back";
  const intro = isVerify
    ? `We sent a six-digit code to <strong>${escapeHtml(state.pendingEmail)}</strong>. Enter it here to verify your email.`
    : isRegister
      ? "Start with a verified email address. Your tasks and habits stay private to your account."
      : "Sign in to pick up where you left off.";
  let form = "";
  if (isVerify) {
    form = `
      <form data-form="verify" novalidate>
        <div class="field"><label for="verify-code">Six-digit code</label><input id="verify-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></div>
        <p class="field-error" data-form-error></p>
        <button class="btn" type="submit">Verify email and continue</button>
      </form>
      <p class="auth-switch">Didn't receive it? <button class="link-button" data-action="resend-code">Send a new code</button></p>
      <p class="auth-switch"><button class="link-button" data-action="auth-mode" data-mode="register">Use a different email</button></p>`;
  } else {
    form = `
      <form data-form="${isRegister ? "register" : "login"}" novalidate>
        <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" value="${escapeHtml(state.pendingEmail)}" placeholder="you@example.com" required></div>
        <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" minlength="8" maxlength="256" placeholder="${isRegister ? "At least 8 characters" : "Your password"}" required></div>
        <p class="field-error" data-form-error></p>
        <button class="btn" type="submit">${isRegister ? "Create account" : "Sign in"}</button>
      </form>
      <p class="auth-switch">${isRegister ? "Already have an account?" : "New to Daymark?"} <button class="link-button" data-action="auth-mode" data-mode="${isRegister ? "login" : "register"}">${isRegister ? "Sign in" : "Create an account"}</button></p>`;
  }
  root.innerHTML = `
    <main class="auth-screen">
      <section class="auth-story">
        <a class="brand-lockup" href="#today" aria-label="Daymark home"><span class="brand-glyph">D</span><span>daymark</span></a>
        <div class="auth-copy">
          <div class="eyebrow">A little more room in your day</div>
          <h1>Make space for what matters.</h1>
          <p>Plan around your time and energy, then focus on the next right thing.</p>
          <ul class="auth-list">
            <li><span>✓</span> A clear, realistic daily plan</li>
            <li><span>✓</span> Projects, tasks, and habits together</li>
            <li><span>✓</span> Gentle reminders and focus sessions</li>
          </ul>
        </div>
        <div class="auth-story-foot">DAYMARK · PERSONAL PLANNING, AT YOUR PACE</div>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <div class="eyebrow">${isVerify ? "Email confirmation" : isRegister ? "Start your day well" : "Your space is ready"}</div>
          <h2>${title}</h2>
          <p>${intro}</p>
          ${form}
          ${!isVerify ? `<div class="auth-note"><span>✳</span><span>New accounts must verify access to their email before signing in. We never include SMTP credentials in the source package.</span></div>` : ""}
          <button class="back-home" data-action="auth-mode" data-mode="login">Back to sign in</button>
        </div>
      </section>
    </main>`;
}

function renderShell() {
  const dueCount = state.tasks.filter((task) => task.status !== "done" && task.dueDate === localDateISO()).length;
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><span class="brand-glyph">D</span><span>daymark</span></div>
        <div class="nav-label">Your space</div>
        <nav class="side-nav" aria-label="Main navigation">
          ${Object.keys(PAGE_NAMES).map((key) => `
            <button class="nav-item ${state.page === key ? "active" : ""}" data-action="navigate" data-page="${key}" aria-current="${state.page === key ? "page" : "false"}">
              <span class="icon" aria-hidden="true">${PAGE_ICONS[key]}</span><span>${PAGE_NAMES[key]}</span>
              ${key === "today" && dueCount ? `<span class="nav-count">${dueCount}</span>` : ""}
            </button>`).join("")}
        </nav>
        <div class="sidebar-bottom">
          <div class="capacity-mini">
            <div class="eyebrow">Today's capacity</div>
            <strong><span id="sidebar-planned">${state.settings ? Math.min(state.dashboardMinutes || 0, state.settings.dailyCapacityMinutes) : "—"}</span> <span class="small muted">min planned</span></strong>
            <div class="progress-track"><div id="sidebar-capacity-progress" class="progress-fill" style="width:${capacityPercent(state.dashboardMinutes || 0, state.settings?.dailyCapacityMinutes || 360)}%"></div></div>
            <div id="sidebar-capacity-label" class="muted small" style="margin-top:6px">${state.settings ? `${state.settings.dailyCapacityMinutes} min available` : "Loading your plan…"}</div>
          </div>
          <div class="sidebar-user">
            <span class="avatar">${escapeHtml(initials(state.user?.email))}</span>
            <span class="user-copy"><strong>${escapeHtml(state.user?.email)}</strong><span>Personal workspace</span></span>
          </div>
        </div>
      </aside>
      <main class="app-main">
        <header class="topbar">
          <div class="mobile-brand"><span class="brand-glyph">D</span><span>daymark</span></div>
          <div class="topbar-date">${escapeHtml(fullDateLabel())}</div>
          <button class="topbar-button" data-action="new-task"><span aria-hidden="true">＋</span> New task</button>
          <button class="topbar-button" data-action="logout"><span aria-hidden="true">↗</span> Sign out</button>
        </header>
        <section id="page-content" class="page" aria-live="polite"><div class="card empty-state"><div class="empty-icon">◌</div><h3>Loading your day</h3></div></section>
      </main>
    </div>`;
}

function capacityPercent(planned, capacity) {
  if (!capacity) return 0;
  return Math.min(100, Math.max(0, Math.round((planned / capacity) * 100)));
}

async function renderCurrentPage() {
  if (state.page !== "today" && state.page !== "focus" && state.page !== "settings") {
    state.tasks = await api("/api/tasks");
  }
  if (state.page === "today") return renderToday();
  if (state.page === "tasks") return renderTasks();
  if (state.page === "projects") return renderProjects();
  if (state.page === "habits") return renderHabits();
  if (state.page === "focus") return renderFocus();
  if (state.page === "settings") return renderSettings();
}

function setPageContent(html) {
  const content = document.getElementById("page-content");
  if (content) content.innerHTML = html;
}

function pageHeading(eyebrow, title, subtitle, action = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>${action}</div>`;
}

function planTasks(tasks, settings, today = localDateISO()) {
  const windowName = settings?.energyWindow || "morning";
  const ranks = { urgent: 0, high: 1, medium: 2, low: 3 };
  return tasks.filter((task) => task.status !== "done" && (!task.dueDate || task.dueDate <= today))
    .sort((a, b) =>
      (ranks[a.priority] ?? 3) - (ranks[b.priority] ?? 3)
      || (a.preferredTime === windowName ? -1 : b.preferredTime === windowName ? 1 : a.preferredTime === "anytime" ? -1 : 1)
      || (a.energyLevel === "high" ? -1 : b.energyLevel === "high" ? 1 : 0)
      || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
    .slice(0, 5);
}

function renderTaskMeta(task) {
  const due = task.dueDate ? `<span class="pill ${task.dueDate < localDateISO() && task.status !== "done" ? "priority-high" : ""}">${escapeHtml(humanDate(task.dueDate))}</span>` : "";
  const priority = task.priority && task.priority !== "low" ? `<span class="pill priority-${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_NAMES[task.priority] || task.priority)}</span>` : "";
  const project = task.projectId ? state.projects.find((item) => item.id === task.projectId) : null;
  const projectPill = project ? `<span class="pill">${escapeHtml(project.name)}</span>` : "";
  const tags = (task.tags || []).slice(0, 3).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("");
  const subtaskCount = (task.subtasks || []).length;
  const subtaskPill = subtaskCount ? `<span class="pill">${(task.subtasks || []).filter((item) => item.done).length}/${subtaskCount} steps</span>` : "";
  return `<div class="task-meta">${due}${priority}${projectPill}${tags}${subtaskPill}</div>`;
}

function taskRow(task, showActions = true) {
  const isDone = task.status === "done";
  const taskName = escapeHtml(task.title);
  return `<div class="task-row" data-task-row="${escapeHtml(task.id)}">
    <button class="task-check ${isDone ? "checked" : ""}" data-action="toggle-task" data-id="${escapeHtml(task.id)}" aria-label="${isDone ? "Reopen" : "Complete"} ${taskName}" aria-pressed="${isDone}">${isDone ? "✓" : ""}</button>
    <div class="task-copy ${isDone ? "is-done" : ""}">
      <strong data-action="edit-task" data-id="${escapeHtml(task.id)}" role="button" tabindex="0">${taskName}</strong>
      ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
      ${renderTaskMeta(task)}
    </div>
    ${showActions ? `<div class="task-row-actions"><button class="mini-action" data-action="edit-task" data-id="${escapeHtml(task.id)}" aria-label="Edit ${taskName}">✎</button><button class="mini-action" data-action="delete-task" data-id="${escapeHtml(task.id)}" aria-label="Delete ${taskName}">×</button></div>` : ""}
  </div>`;
}

async function renderToday() {
  const [dashboard, tasks, projects, habits, settings] = await Promise.all([
    api("/api/dashboard"), api("/api/tasks"), api("/api/projects"), api("/api/habits"), api("/api/settings"),
  ]);
  state.dashboard = dashboard;
  state.dashboardMinutes = dashboard.minutesPlanned;
  state.tasks = tasks;
  state.projects = projects;
  state.habits = habits;
  state.settings = settings;
  const sidebarPlanned = document.getElementById("sidebar-planned");
  const sidebarProgress = document.getElementById("sidebar-capacity-progress");
  const sidebarLabel = document.getElementById("sidebar-capacity-label");
  if (sidebarPlanned) sidebarPlanned.textContent = String(Math.min(dashboard.minutesPlanned, settings.dailyCapacityMinutes));
  if (sidebarProgress) sidebarProgress.style.width = `${capacityPercent(dashboard.minutesPlanned, settings.dailyCapacityMinutes)}%`;
  if (sidebarLabel) sidebarLabel.textContent = `${settings.dailyCapacityMinutes} min available`;
  const planned = planTasks(tasks, settings);
  const userName = (state.user.email.split("@")[0] || "there").replace(/[._-]+/g, " ");
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const activity = dashboard.weeklyActivity || Array(7).fill(0);
  const dayNames = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setDate(day.getDate() - (6 - index));
    return day.toLocaleDateString(undefined, { weekday: "narrow" });
  });
  const maxActivity = Math.max(1, ...activity);
  const completedTasks = tasks.filter((task) => task.status === "done").slice(0, 4);
  const firstName = userName.charAt(0).toUpperCase() + userName.slice(1);
  const content = `
    <div class="dashboard-grid">
      <div class="dashboard-main">
        <section class="welcome-card">
          <div class="eyebrow">${escapeHtml(fullDateLabel())}</div>
          <h2>${greeting}, ${escapeHtml(firstName)}.</h2>
          <p>A thoughtful plan leaves room for the unexpected. Start with one useful thing.</p>
          <button class="btn btn-gold btn-small" data-action="new-task"><span aria-hidden="true">＋</span> Add a task</button>
        </section>
        <section class="stats-grid" aria-label="Today's overview">
          ${statCard("Due today", dashboard.dueTodayCount, "on your list", "stat-gold")}
          ${statCard("Overdue", dashboard.overdueCount, "ready for a reset", "stat-rust")}
          ${statCard("Focus time", `${dashboard.focusMinutesToday}m`, "today", "stat-blue")}
          ${statCard("Habit streak", `${dashboard.currentStreak}d`, "longest current streak", "stat-green")}
        </section>
        <section class="card">
          <div class="section-head"><div><div class="eyebrow">A good place to begin</div><h2 class="section-title">Your plan for today</h2></div><button class="link-button small" data-action="navigate" data-page="tasks">All tasks →</button></div>
          ${planned.length ? `<div class="panel-list">${planned.map((task, index) => `<div class="plan-item"><span class="plan-number">0${index + 1}</span><div class="plan-copy"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(PRIORITY_NAMES[task.priority] || "Task")} · ${task.estimateMinutes} min · ${escapeHtml(task.energyLevel)} energy</span></div><span class="plan-time">${escapeHtml(task.preferredTime === "anytime" ? "FLEXIBLE" : task.preferredTime.toUpperCase())}</span></div>`).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">✳</div><h3>Your day has room</h3><p>Add a task or take a moment to celebrate the work you have already finished.</p><button class="btn btn-quiet btn-small" data-action="new-task">Add a task</button></div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><div class="eyebrow">Small steps add up</div><h2 class="section-title">This week's progress</h2></div><span class="pill">${dashboard.completedCount} completed</span></div>
          <div class="activity-bars" aria-label="Completed tasks over the last seven days">
            ${activity.map((count, index) => `<div class="activity-day"><div class="activity-bar-wrap"><div class="activity-bar ${index === 6 ? "today" : ""}" style="height:${Math.max(7, Math.round(count / maxActivity * 70))}px" title="${count} completed"></div></div><span>${dayNames[index]}</span></div>`).join("")}
          </div>
        </section>
      </div>
      <aside class="dashboard-aside">
        <section class="card">
          <div class="section-head"><div><div class="eyebrow">Built around you</div><h2 class="section-title">Daily capacity</h2></div><span class="icon" aria-hidden="true">◷</span></div>
          <div class="capacity-meter"><span>${dashboard.minutesPlanned} min planned</span><strong>${dashboard.minutesCapacity} min</strong></div>
          <div class="progress-track"><div class="progress-fill" style="width:${capacityPercent(dashboard.minutesPlanned, dashboard.minutesCapacity)}%"></div></div>
          <p class="muted small">${dashboard.minutesPlanned > dashboard.minutesCapacity ? "Your plan is above your daily capacity. Consider moving something." : "Your plan leaves a little room between tasks."}</p>
          <div class="energy-note"><div class="eyebrow">Your best energy</div><strong>${escapeHtml(settings.energyWindow[0].toUpperCase() + settings.energyWindow.slice(1))}</strong><p>Daymark puts matching tasks earlier in your suggested plan.</p></div>
        </section>
        <section class="card">
          <div class="section-head"><div><div class="eyebrow">A small win</div><h2 class="section-title">Recent completions</h2></div></div>
          ${completedTasks.length ? `<div class="panel-list">${completedTasks.map((task) => taskRow(task, false)).join("")}</div>` : `<div class="empty-state"><div class="empty-icon">✓</div><h3>Ready when you are</h3><p>Completed tasks will show up here.</p></div>`}
        </section>
        <section class="card">
          <div class="section-head"><div><div class="eyebrow">Keep it going</div><h2 class="section-title">Your habits</h2></div><button class="link-button small" data-action="navigate" data-page="habits">View →</button></div>
          ${habits.length ? `<div class="panel-list">${habits.slice(0, 3).map((habit) => `<div class="task-row"><span class="habit-flower" style="width:30px;height:30px;min-width:30px;font-size:14px">✳</span><div class="task-copy"><strong>${escapeHtml(habit.name)}</strong><p>${habit.streak} day streak · ${habit.completedDates.includes(localDateISO()) ? "done today" : "ready for today"}</p></div><button class="task-check ${habit.completedDates.includes(localDateISO()) ? "checked" : ""}" data-action="complete-habit" data-id="${escapeHtml(habit.id)}" aria-label="Check in ${escapeHtml(habit.name)}">${habit.completedDates.includes(localDateISO()) ? "✓" : ""}</button></div>`).join("")}</div>` : `<div class="empty-state"><h3>Build a gentle routine</h3><p>Add a habit to see your streaks here.</p><button class="btn btn-quiet btn-small" data-action="new-habit">Add a habit</button></div>`}
        </section>
      </aside>
    </div>`;
  setPageContent(content);
}

function statCard(label, value, note, extra) {
  return `<div class="stat-card ${extra}"><div class="stat-label">${label}</div><strong>${escapeHtml(value)}</strong><div class="stat-note">${note}</div></div>`;
}

function taskRowsHtml(tasks) {
  if (!tasks.length) {
    return `<div class="empty-state"><div class="empty-icon">☷</div><h3>No tasks here</h3><p>Add a task, choose a due date, or change the status filter.</p><button class="btn btn-quiet btn-small" data-action="new-task">Create a task</button></div>`;
  }
  return `<div class="task-table">
    <div class="task-table-head"><span>Task</span><span>Status</span><span>Priority</span><span>Due date</span><span></span></div>
    ${tasks.map((task) => `<div class="task-table-row" data-task-row="${escapeHtml(task.id)}">
      ${taskRow(task, false)}
      <span class="row-status"><span class="pill status-${escapeHtml(task.status)}">${escapeHtml(STATUS_NAMES[task.status])}</span></span>
      <span class="row-priority"><span class="pill priority-${escapeHtml(task.priority)}">${escapeHtml(PRIORITY_NAMES[task.priority])}</span></span>
      <span class="row-due"><span class="pill ${task.dueDate && task.dueDate < localDateISO() && task.status !== "done" ? "priority-high" : ""}">${escapeHtml(humanDate(task.dueDate))}</span></span>
      <span class="task-row-actions"><button class="mini-action" data-action="edit-task" data-id="${escapeHtml(task.id)}" aria-label="Edit task">✎</button><button class="mini-action" data-action="delete-task" data-id="${escapeHtml(task.id)}" aria-label="Delete task">×</button></span>
    </div>`).join("")}
  </div>`;
}

function taskBoardHtml(tasks) {
  return `<div class="board">${Object.entries(STATUS_NAMES).map(([status, label]) => {
    const inColumn = tasks.filter((task) => task.status === status);
    return `<section class="board-column"><h3 class="board-heading"><span>${label}</span><span class="pill">${inColumn.length}</span></h3>
      ${inColumn.map((task) => `<article class="board-task">
        <div class="task-copy ${status === "done" ? "is-done" : ""}"><strong data-action="edit-task" data-id="${escapeHtml(task.id)}" role="button" tabindex="0">${escapeHtml(task.title)}</strong>${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}${renderTaskMeta(task)}</div>
        <div class="board-task-actions"><button class="mini-action" data-action="advance-task" data-id="${escapeHtml(task.id)}" aria-label="Move task to next status">${status === "todo" ? "→" : status === "in_progress" ? "✓" : "↶"}</button><div><button class="mini-action" data-action="edit-task" data-id="${escapeHtml(task.id)}" aria-label="Edit task">✎</button><button class="mini-action" data-action="delete-task" data-id="${escapeHtml(task.id)}" aria-label="Delete task">×</button></div></div>
      </article>`).join("") || `<div class="muted small">Nothing in this column yet.</div>`}
    </section>`;
  }).join("")}</div>`;
}

async function renderTasks() {
  const [tasks, projects] = await Promise.all([api("/api/tasks"), api("/api/projects")]);
  state.tasks = tasks;
  state.projects = projects;
  const filtered = filterTasks(tasks);
  const view = state.taskView;
  const content = `
    ${pageHeading("One step at a time", "Your tasks", "Keep the important things visible and let the rest wait.", `<button class="btn" data-action="new-task"><span aria-hidden="true">＋</span> New task</button>`)}
    <div class="toolbar">
      <input class="search-field" type="search" data-task-search value="${escapeHtml(state.taskSearch)}" placeholder="Search your tasks…" aria-label="Search tasks">
      <select data-task-filter aria-label="Filter task status">
        ${["all", ...Object.keys(STATUS_NAMES)].map((value) => `<option value="${value}" ${state.taskStatusFilter === value ? "selected" : ""}>${value === "all" ? "All statuses" : STATUS_NAMES[value]}</option>`).join("")}
      </select>
      <span class="toolbar-spacer"></span>
      <div class="view-toggle" aria-label="Task view">
        <button class="${view === "list" ? "active" : ""}" data-action="task-view" data-view="list">List</button>
        <button class="${view === "board" ? "active" : ""}" data-action="task-view" data-view="board">Board</button>
      </div>
    </div>
    <section class="card ${view === "list" ? "card-flush" : ""}" id="task-results">${view === "list" ? taskRowsHtml(filtered) : taskBoardHtml(filtered)}</section>`;
  setPageContent(content);
}

function filterTasks(tasks) {
  const search = state.taskSearch.trim().toLowerCase();
  return tasks.filter((task) => (state.taskStatusFilter === "all" || task.status === state.taskStatusFilter)
    && (!search || `${task.title} ${task.description || ""} ${(task.tags || []).join(" ")}`.toLowerCase().includes(search)));
}

async function renderProjects() {
  const [projects, tasks] = await Promise.all([api("/api/projects"), api("/api/tasks")]);
  state.projects = projects;
  state.tasks = tasks;
  const html = `
    ${pageHeading("Everything has a place", "Your projects", "Group related tasks and keep a clear view of each goal.", `<button class="btn" data-action="new-project"><span aria-hidden="true">＋</span> New project</button>`)}
    ${projects.length ? `<div class="project-grid">${projects.map((project) => {
      const count = tasks.filter((task) => task.projectId === project.id).length;
      const done = tasks.filter((task) => task.projectId === project.id && task.status === "done").length;
      return `<article class="project-card">
        <div class="project-color" style="background:${escapeHtml(project.color)}"></div>
        <h3>${escapeHtml(project.name)}</h3>
        <p>${escapeHtml(project.description || "A space for related tasks and notes.")}</p>
        <div class="project-card-foot"><span>${count} ${count === 1 ? "task" : "tasks"} · ${done} done</span><span class="inline-actions"><button class="mini-action" data-action="edit-project" data-id="${escapeHtml(project.id)}" aria-label="Edit ${escapeHtml(project.name)}">✎</button><button class="mini-action" data-action="delete-project" data-id="${escapeHtml(project.id)}" aria-label="Delete ${escapeHtml(project.name)}">×</button></span></div>
      </article>`;
    }).join("")}</div>` : `<section class="card empty-state"><div class="empty-icon">▧</div><h3>Start with a project</h3><p>Projects bring related tasks together and make progress easier to see.</p><button class="btn btn-quiet" data-action="new-project">Create a project</button></section>`}`;
  setPageContent(html);
}

function dateWindowForHabits() {
  return Array.from({ length: 7 }, (_, index) => {
    const value = new Date();
    value.setDate(value.getDate() - (6 - index));
    return value;
  });
}

async function renderHabits() {
  const habits = await api("/api/habits");
  state.habits = habits;
  const days = dateWindowForHabits();
  const today = localDateISO();
  const html = `
    ${pageHeading("A little, often", "Your habits", "Small routines are easier to keep when you can see them grow.", `<button class="btn" data-action="new-habit"><span aria-hidden="true">＋</span> New habit</button>`)}
    ${habits.length ? `<div class="habit-list">${habits.map((habit) => {
      const checkedToday = habit.completedDates.includes(today);
      const weeklyCount = habit.completedDates.filter((item) => item >= localDateISO(new Date(Date.now() - 6 * 86400000))).length;
      return `<article class="habit-card">
        <div class="habit-title"><span class="habit-flower">✳</span><div><h3>${escapeHtml(habit.name)}</h3><p>${weeklyCount} of ${habit.targetPerWeek} days this week · ${habit.streak} day streak</p></div></div>
        <div class="habit-week" aria-label="Last seven days">${days.map((day) => {
          const iso = localDateISO(day);
          const done = habit.completedDates.includes(iso);
          return `<div class="habit-day ${iso === today ? "today" : ""}"><span>${day.toLocaleDateString(undefined, { weekday: "narrow" })}</span><span class="habit-day-dot ${done ? "done" : ""}" title="${escapeHtml(humanDate(iso))}">${done ? "✓" : ""}</span></div>`;
        }).join("")}</div>
        <div class="habit-actions"><span class="habit-streak">✦ ${habit.streak} day${habit.streak === 1 ? "" : "s"}</span><button class="btn ${checkedToday ? "btn-secondary" : "btn-quiet"} btn-small" data-action="complete-habit" data-id="${escapeHtml(habit.id)}" ${checkedToday ? "disabled" : ""}>${checkedToday ? "Done today" : "Check in"}</button><button class="mini-action" data-action="edit-habit" data-id="${escapeHtml(habit.id)}" aria-label="Edit ${escapeHtml(habit.name)}">✎</button><button class="mini-action" data-action="delete-habit" data-id="${escapeHtml(habit.id)}" aria-label="Delete ${escapeHtml(habit.name)}">×</button></div>
      </article>`;
    }).join("")}</div>` : `<section class="card empty-state"><div class="empty-icon">✳</div><h3>Choose one small routine</h3><p>Track the habits that help you feel well, focused, or ready for the day.</p><button class="btn btn-quiet" data-action="new-habit">Add your first habit</button></section>`}`;
  setPageContent(html);
}

function timerMarkup() {
  const total = state.timerMinutes * 60;
  const remaining = Math.max(0, state.timerRemaining);
  const progress = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = Math.floor(remaining % 60).toString().padStart(2, "0");
  return `<div class="timer-ring" style="--timer-progress:${progress}%"><div class="timer-inner"><span class="timer-time" id="timer-time">${minutes}:${seconds}</span><span class="timer-caption">${state.timerRunning ? "Stay with this moment" : "A little space to focus"}</span></div></div>`;
}

async function renderFocus() {
  const [sessions, tasks] = await Promise.all([api("/api/focus-sessions"), api("/api/tasks")]);
  state.focusSessions = sessions;
  state.tasks = tasks;
  const selectableTasks = tasks.filter((task) => task.status !== "done");
  const today = localDateISO();
  const sessionsToday = sessions.filter((item) => item.completedAt && localDateISO(new Date(item.completedAt)) === today);
  const minutesToday = sessionsToday.reduce((sum, item) => sum + item.durationMinutes, 0);
  const taskOptions = selectableTasks.map((task) => `<option value="${escapeHtml(task.id)}" ${state.timerTaskId === task.id ? "selected" : ""}>${escapeHtml(task.title)}</option>`).join("");
  const history = sessions.slice(0, 8).map((session) => {
    const linked = tasks.find((task) => task.id === session.taskId);
    return `<div class="history-row"><strong>${escapeHtml(linked?.title || "Focus session")}</strong><span>${session.durationMinutes} min · ${escapeHtml(humanDate(localDateISO(new Date(session.completedAt))))}</span></div>`;
  }).join("");
  const html = `
    ${pageHeading("Take one thing at a time", "Focus", "Give one task your attention, then take a proper pause.")}
    <div class="focus-layout">
      <section class="card timer-card">
        <div class="eyebrow">A quiet interval</div>
        ${timerMarkup()}
        <div class="field" style="width:min(100%,350px);text-align:left"><label for="focus-task">What are you focusing on?</label><select id="focus-task" class="control"><option value="">Just focus</option>${taskOptions}</select></div>
        <div class="timer-controls"><button class="btn ${state.timerRunning ? "btn-quiet" : ""}" data-action="focus-toggle">${state.timerRunning ? "Pause" : state.timerRemaining < state.timerMinutes * 60 ? "Resume" : "Start focus"}</button><button class="btn btn-quiet" data-action="focus-reset">Reset</button></div>
        <div class="timer-presets">${[25, 45, 60].map((minutes) => `<button class="timer-preset ${state.timerMinutes === minutes ? "active" : ""}" data-action="timer-preset" data-minutes="${minutes}">${minutes} min</button>`).join("")}</div>
      </section>
      <aside>
        <section class="card"><div class="eyebrow">Today's focus</div><h2 class="section-title" style="margin-top:7px">${minutesToday} minutes</h2><p class="muted small">${sessionsToday.length} completed ${sessionsToday.length === 1 ? "session" : "sessions"} today</p><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, minutesToday / 120 * 100)}%"></div></div></section>
        <section class="card"><div class="section-head"><div><div class="eyebrow">Your recent sessions</div><h2 class="section-title">Focus history</h2></div></div>${history ? `<div class="history-list">${history}</div>` : `<div class="empty-state"><div class="empty-icon">◉</div><h3>No sessions yet</h3><p>Start with 25 minutes. You can pause whenever you need.</p></div>`}</section>
      </aside>
    </div>`;
  setPageContent(html);
}

async function renderSettings() {
  const settings = await api("/api/settings");
  state.settings = settings;
  const permission = "Notification" in window ? Notification.permission : "unsupported";
  const html = `
    ${pageHeading("Make Daymark yours", "Settings", "Choose how Daymark fits into your day.")}
    <div class="settings-grid">
      <section class="card">
        <div class="eyebrow">Daily rhythm</div><h2 class="section-title" style="margin:6px 0 14px">Your planning preferences</h2>
        <form data-form="settings">
          <div class="setting-row"><div class="setting-copy"><strong>Daily capacity</strong><span>How much focused task time feels realistic?</span></div><select class="setting-control control" name="dailyCapacityMinutes"><option value="180" ${settings.dailyCapacityMinutes === 180 ? "selected" : ""}>3 hours</option><option value="240" ${settings.dailyCapacityMinutes === 240 ? "selected" : ""}>4 hours</option><option value="360" ${settings.dailyCapacityMinutes === 360 ? "selected" : ""}>6 hours</option><option value="480" ${settings.dailyCapacityMinutes === 480 ? "selected" : ""}>8 hours</option><option value="600" ${settings.dailyCapacityMinutes === 600 ? "selected" : ""}>10 hours</option><option value="${settings.dailyCapacityMinutes}" ${![180,240,360,480,600].includes(settings.dailyCapacityMinutes) ? "selected" : ""}>${Math.round(settings.dailyCapacityMinutes / 60 * 10) / 10} hours (custom)</option></select></div>
          <div class="setting-row"><div class="setting-copy"><strong>Best energy window</strong><span>Daymark prioritizes matching tasks in your plan.</span></div><select class="setting-control control" name="energyWindow"><option value="morning" ${settings.energyWindow === "morning" ? "selected" : ""}>Morning</option><option value="afternoon" ${settings.energyWindow === "afternoon" ? "selected" : ""}>Afternoon</option><option value="evening" ${settings.energyWindow === "evening" ? "selected" : ""}>Evening</option></select></div>
          <div class="setting-row"><div class="setting-copy"><strong>Reminder sound</strong><span>Preview a tone, then choose your default.</span></div><div class="setting-control inline-actions"><select class="control" name="sound">${Object.entries(SOUND_NAMES).map(([key, label]) => `<option value="${key}" ${settings.sound === key ? "selected" : ""}>${label}</option>`).join("")}</select><button class="btn btn-quiet btn-small" type="button" data-action="test-sound">Test</button></div></div>
          <div class="setting-row"><div class="setting-copy"><strong>Browser reminders</strong><span>Notifications: ${escapeHtml(permission)} · page must stay open</span></div><div class="setting-control"><button class="switch" type="button" role="switch" aria-checked="${settings.notificationsEnabled && permission !== "denied"}" data-action="notification-toggle" aria-label="Toggle browser reminders"></button><input type="hidden" name="notificationsEnabled" value="${settings.notificationsEnabled && permission !== "denied"}"></div></div>
          <div class="notification-preview"><span>◷</span><div>Reminders use your browser's notification permission and play the selected tone while Daymark is open. Your browser may require one click to start sound.</div></div>
          <div class="setting-row"><div class="setting-copy"><strong>Local time zone</strong><span>Used for due dates, reminders, and habit streaks.</span></div><span class="pill">${escapeHtml(settings.timezone || timezoneName())}</span></div>
          <div class="inline-actions" style="justify-content:flex-end;margin-top:18px"><button class="btn" type="submit">Save preferences</button></div>
        </form>
      </section>
      <aside class="note-card"><div class="eyebrow">A note on reminders</div><h3>Gentle, not distracting</h3><p>Daymark checks scheduled reminders while this page is open. You can turn browser notifications on or off at any time, and choose one of five soft synthesized tones.</p></aside>
    </div>`;
  setPageContent(html);
}

function openModal(content, narrow = false) {
  const existing = document.getElementById("modal-backdrop");
  if (existing) existing.remove();
  const wrapper = document.createElement("div");
  wrapper.id = "modal-backdrop";
  wrapper.className = "modal-backdrop";
  wrapper.innerHTML = `<section class="modal ${narrow ? "modal-narrow" : ""}" role="dialog" aria-modal="true">${content}</section>`;
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper) wrapper.remove();
  });
  document.body.append(wrapper);
  const first = wrapper.querySelector("input,select,textarea,button");
  if (first) first.focus();
}

function closeModal() {
  document.getElementById("modal-backdrop")?.remove();
}

function localDateTimeValue(iso) {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function openTaskDialog(taskId = "") {
  const task = state.tasks.find((item) => item.id === taskId);
  const projects = state.projects || [];
  const taskSubtasks = task?.subtasks || [];
  const form = `
    <div class="modal-head"><div><div class="eyebrow">${task ? "Make a change" : "One thing at a time"}</div><h2>${task ? "Edit task" : "Create a task"}</h2><p>Give it a clear name and decide when it fits.</p></div><button class="modal-x" type="button" data-action="close-modal" aria-label="Close">×</button></div>
    <form data-form="task" data-id="${escapeHtml(task?.id || "")}">
      <div class="form-grid">
        <div class="field span-2"><label for="task-title">Task name</label><input id="task-title" name="title" maxlength="240" required value="${escapeHtml(task?.title || "")}" placeholder="What needs doing?"></div>
        <div class="field span-2"><label for="task-description">Notes</label><textarea id="task-description" name="description" maxlength="4000" placeholder="Add a little context…">${escapeHtml(task?.description || "")}</textarea></div>
        <div class="field"><label for="task-status">Status</label><select id="task-status" name="status">${Object.entries(STATUS_NAMES).map(([key, label]) => `<option value="${key}" ${task?.status === key || (!task && key === "todo") ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="field"><label for="task-priority">Priority</label><select id="task-priority" name="priority">${Object.entries(PRIORITY_NAMES).map(([key, label]) => `<option value="${key}" ${task?.priority === key || (!task && key === "medium") ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="field"><label for="task-project">Project</label><select id="task-project" name="projectId"><option value="">No project</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}" ${task?.projectId === project.id ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="task-due">Due date</label><input id="task-due" name="dueDate" type="date" value="${escapeHtml(task?.dueDate || "")}"></div>
        <div class="field"><label for="task-reminder">Reminder</label><input id="task-reminder" name="reminderAt" type="datetime-local" value="${escapeHtml(localDateTimeValue(task?.reminderAt))}"><span class="field-hint">Uses your local time. Notifications need the page open.</span></div>
        <div class="field"><label for="task-estimate">Estimate (minutes)</label><input id="task-estimate" name="estimateMinutes" type="number" min="5" max="1440" step="5" value="${task?.estimateMinutes || 30}"></div>
        <div class="field"><label for="task-energy">Energy level</label><select id="task-energy" name="energyLevel">${["low", "medium", "high"].map((value) => `<option value="${value}" ${task?.energyLevel === value || (!task && value === "medium") ? "selected" : ""}>${value[0].toUpperCase() + value.slice(1)}</option>`).join("")}</select></div>
        <div class="field"><label for="task-time">Best time</label><select id="task-time" name="preferredTime">${[["anytime","Any time"],["morning","Morning"],["afternoon","Afternoon"],["evening","Evening"]].map(([key, label]) => `<option value="${key}" ${task?.preferredTime === key || (!task && key === "anytime") ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="field"><label for="task-repeat">Repeat</label><select id="task-repeat" name="recurrence">${[["none","Does not repeat"],["daily","Daily"],["weekdays","Weekdays"],["weekly","Weekly"]].map(([key, label]) => `<option value="${key}" ${task?.recurrence === key || (!task && key === "none") ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="field span-2"><label for="task-tags">Tags</label><input id="task-tags" name="tags" value="${escapeHtml((task?.tags || []).join(", "))}" placeholder="work, personal, errands"><span class="tag-hint">Separate tags with commas.</span></div>
        <div class="field span-2"><label for="task-subtasks">Subtasks</label><textarea id="task-subtasks" name="subtasks" placeholder="One step per line">${escapeHtml(taskSubtasks.map((item) => item.title).join("\n"))}</textarea><span class="tag-hint">${taskSubtasks.filter((item) => item.done).length} of ${taskSubtasks.length} existing steps complete. Saving edited steps keeps matching completion states.</span></div>
      </div>
      <p class="field-error" data-form-error></p>
      <div class="modal-foot"><button class="btn btn-quiet" type="button" data-action="close-modal">Cancel</button><button class="btn" type="submit">${task ? "Save task" : "Create task"}</button></div>
    </form>`;
  openModal(form);
}

function openProjectDialog(projectId = "") {
  const project = state.projects.find((item) => item.id === projectId);
  openModal(`
    <div class="modal-head"><div><div class="eyebrow">A space for your work</div><h2>${project ? "Edit project" : "Create a project"}</h2></div><button class="modal-x" type="button" data-action="close-modal" aria-label="Close">×</button></div>
    <form data-form="project" data-id="${escapeHtml(project?.id || "")}">
      <div class="field"><label for="project-name">Project name</label><input id="project-name" name="name" maxlength="100" required value="${escapeHtml(project?.name || "")}" placeholder="e.g. Spring garden"></div>
      <div class="field" style="margin-top:14px"><label for="project-description">Description</label><textarea id="project-description" name="description" maxlength="1000" placeholder="What does this project mean to you?">${escapeHtml(project?.description || "")}</textarea></div>
      <div class="field" style="margin-top:14px"><label for="project-color">Color</label><input id="project-color" name="color" type="color" value="${escapeHtml(project?.color || "#6c9a7e")}" style="min-height:42px;padding:5px"></div>
      <p class="field-error" data-form-error></p><div class="modal-foot"><button class="btn btn-quiet" type="button" data-action="close-modal">Cancel</button><button class="btn" type="submit">${project ? "Save project" : "Create project"}</button></div>
    </form>`, true);
}

function openHabitDialog(habitId = "") {
  const habit = state.habits.find((item) => item.id === habitId);
  openModal(`
    <div class="modal-head"><div><div class="eyebrow">Make it manageable</div><h2>${habit ? "Edit habit" : "Add a habit"}</h2><p>Choose a routine you can return to.</p></div><button class="modal-x" type="button" data-action="close-modal" aria-label="Close">×</button></div>
    <form data-form="habit" data-id="${escapeHtml(habit?.id || "")}">
      <div class="field"><label for="habit-name">Habit name</label><input id="habit-name" name="name" maxlength="100" required value="${escapeHtml(habit?.name || "")}" placeholder="e.g. Take a short walk"></div>
      <div class="field" style="margin-top:14px"><label for="habit-target">Weekly target</label><select id="habit-target" name="targetPerWeek">${[1,2,3,4,5,6,7].map((value) => `<option value="${value}" ${habit?.targetPerWeek === value || (!habit && value === 5) ? "selected" : ""}>${value} ${value === 1 ? "day" : "days"} a week</option>`).join("")}</select></div>
      <p class="field-error" data-form-error></p><div class="modal-foot"><button class="btn btn-quiet" type="button" data-action="close-modal">Cancel</button><button class="btn" type="submit">${habit ? "Save habit" : "Create habit"}</button></div>
    </form>`, true);
}

function taskPayload(form, existing) {
  const data = new FormData(form);
  const tags = String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20);
  const previous = existing?.subtasks || [];
  const oldByTitle = new Map(previous.map((item) => [item.title.toLowerCase(), item]));
  const subtasks = String(data.get("subtasks") || "").split("\n").map((title) => title.trim()).filter(Boolean).slice(0, 40).map((title) => {
    const old = oldByTitle.get(title.toLowerCase());
    return { id: old?.id, title, done: old?.done || false };
  });
  const dueDate = String(data.get("dueDate") || "");
  const reminderValue = String(data.get("reminderAt") || "");
  const reminderAt = reminderValue ? new Date(reminderValue).toISOString() : "";
  return {
    title: String(data.get("title") || "").trim(),
    description: String(data.get("description") || "").trim() || null,
    status: String(data.get("status") || "todo"),
    priority: String(data.get("priority") || "medium"),
    projectId: String(data.get("projectId") || "") || null,
    dueDate: dueDate || null,
    reminderAt: reminderAt || null,
    estimateMinutes: Number(data.get("estimateMinutes") || 30),
    energyLevel: String(data.get("energyLevel") || "medium"),
    preferredTime: String(data.get("preferredTime") || "anytime"),
    recurrence: String(data.get("recurrence") || "none"),
    tags,
    subtasks,
  };
}

function formError(form, message) {
  const output = form.querySelector("[data-form-error]");
  if (output) output.textContent = message;
}

function setFormBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = busy;
    if (busy) button.dataset.originalText = button.textContent;
    button.textContent = busy ? "Please wait…" : (button.dataset.originalText || button.textContent);
  }
}

function reminderKey(task) {
  return `${task.id}:${task.reminderAt}`;
}

function startReminderChecks() {
  if (state.reminderInterval) return;
  state.reminderInterval = window.setInterval(checkReminders, 15_000);
  window.setTimeout(checkReminders, 1800);
}

async function checkReminders() {
  if (!state.user || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    if (!state.settings) state.settings = await api("/api/settings");
    if (!state.settings.notificationsEnabled) return;
    const tasks = await api("/api/tasks");
    state.tasks = tasks;
    const now = Date.now();
    for (const task of tasks) {
      if (!task.reminderAt || task.status === "done") continue;
      const when = new Date(task.reminderAt).getTime();
      const key = reminderKey(task);
      if (!Number.isFinite(when) || when > now || state.reminded.has(key)) continue;
      state.reminded.add(key);
      if (now - when > 30 * 60_000) continue;
      new Notification("Daymark reminder", { body: task.title, tag: key, icon: "/static/daymark.svg" });
      playTone(state.settings.sound);
      try { localStorage.setItem(`daymark-reminded-${state.user.id}`, JSON.stringify([...state.reminded])); } catch { /* browser storage may be disabled */ }
    }
  } catch { /* The next interval will retry transient network errors. */ }
}

function playTone(name = "chime") {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const notes = {
    chime: [880],
    double_ping: [660, 880],
    digital: [520],
    warm_bell: [440, 660, 880],
    rising: [440, 554, 659, 880],
  }[name] || [880];
  const shape = name === "digital" ? "triangle" : "sine";
  notes.forEach((frequency, index) => {
    const start = context.currentTime + index * (name === "double_ping" ? 0.18 : 0.11);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = shape;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(name === "warm_bell" ? 0.08 : 0.055, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.36);
  });
  window.setTimeout(() => context.close().catch(() => {}), 1200);
}

function updateTimer() {
  const timeNode = document.getElementById("timer-time");
  const ring = document.querySelector(".timer-ring");
  if (!timeNode || !ring) return;
  const remaining = Math.max(0, state.timerRemaining);
  timeNode.textContent = `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${Math.floor(remaining % 60).toString().padStart(2, "0")}`;
  const progress = (1 - remaining / (state.timerMinutes * 60)) * 100;
  ring.style.setProperty("--timer-progress", `${progress}%`);
  const caption = ring.querySelector(".timer-caption");
  if (caption) caption.textContent = state.timerRunning ? "Stay with this moment" : "A little space to focus";
  const button = document.querySelector('[data-action="focus-toggle"]');
  if (button) button.textContent = state.timerRunning ? "Pause" : state.timerRemaining < state.timerMinutes * 60 ? "Resume" : "Start focus";
}

async function finishFocusSession() {
  if (state.timerRecorded) return;
  state.timerRecorded = true;
  state.timerRunning = false;
  window.clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.timerRemaining = 0;
  updateTimer();
  try {
    await api("/api/focus-sessions", {
      method: "POST",
      body: JSON.stringify({ durationMinutes: state.timerMinutes, taskId: state.timerTaskId || null }),
    });
    toast("Focus session complete. Take a moment before the next thing.");
    playTone(state.settings?.sound || "chime");
    if ("Notification" in window && Notification.permission === "granted") new Notification("Focus session complete", { body: "Take a short pause before your next task." });
  } catch (error) {
    toast(error.message, "error");
  }
}

function focusTick() {
  if (!state.timerRunning) return;
  const elapsed = Math.floor((Date.now() - state.timerStartedAt) / 1000);
  state.timerRemaining = Math.max(0, state.timerMinutes * 60 - elapsed);
  updateTimer();
  if (state.timerRemaining <= 0) finishFocusSession();
}

function startTimer() {
  if (state.timerRunning) {
    state.timerRemaining = Math.max(0, state.timerMinutes * 60 - Math.floor((Date.now() - state.timerStartedAt) / 1000));
    state.timerRunning = false;
    window.clearInterval(state.timerInterval);
    state.timerInterval = null;
    updateTimer();
    return;
  }
  if (state.timerRemaining <= 0) {
    state.timerRemaining = state.timerMinutes * 60;
    state.timerRecorded = false;
  }
  state.timerStartedAt = Date.now() - ((state.timerMinutes * 60 - state.timerRemaining) * 1000);
  state.timerRunning = true;
  state.timerInterval = window.setInterval(focusTick, 250);
  updateTimer();
}

function resetTimer() {
  window.clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.timerRunning = false;
  state.timerRemaining = state.timerMinutes * 60;
  state.timerRecorded = false;
  updateTimer();
}

function setFilterResults() {
  const results = document.getElementById("task-results");
  if (!results) return;
  const filtered = filterTasks(state.tasks);
  results.innerHTML = state.taskView === "board" ? taskBoardHtml(filtered) : taskRowsHtml(filtered);
}

async function handleClick(event) {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  const id = control.dataset.id;
  try {
    if (action === "navigate") {
      setPage(control.dataset.page);
    } else if (action === "auth-mode") {
      setAuthMode(control.dataset.mode);
    } else if (action === "new-task") {
      if (!state.projects.length) state.projects = await api("/api/projects");
      if (!state.tasks.length) state.tasks = await api("/api/tasks");
      openTaskDialog();
    } else if (action === "edit-task") {
      if (!state.tasks.length) state.tasks = await api("/api/tasks");
      if (!state.projects.length) state.projects = await api("/api/projects");
      openTaskDialog(id);
    } else if (action === "toggle-task") {
      const task = state.tasks.find((item) => item.id === id) || (await api("/api/tasks")).find((item) => item.id === id);
      if (!task) return toast("Task not found.", "error");
      await api(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: task.status === "done" ? "todo" : "done" }),
      });
      toast(task.status === "done" ? "Task moved back to your list." : "Task complete. Nice work.");
      render();
    } else if (action === "advance-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return;
      const next = { todo: "in_progress", in_progress: "done", done: "todo" }[task.status];
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      render();
    } else if (action === "delete-task") {
      const task = state.tasks.find((item) => item.id === id);
      if (!window.confirm(`Delete “${task?.title || "this task"}”?`)) return;
      await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Task deleted.");
      render();
    } else if (action === "task-view") {
      state.taskView = control.dataset.view;
      await renderTasks();
    } else if (action === "new-project") {
      if (!state.projects.length) state.projects = await api("/api/projects");
      openProjectDialog();
    } else if (action === "edit-project") {
      openProjectDialog(id);
    } else if (action === "delete-project") {
      const project = state.projects.find((item) => item.id === id);
      if (!window.confirm(`Delete “${project?.name || "this project"}”? Its tasks will stay in Daymark but become unassigned.`)) return;
      await api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Project deleted. Its tasks are still in your list.");
      render();
    } else if (action === "new-habit") {
      if (!state.habits.length) state.habits = await api("/api/habits");
      openHabitDialog();
    } else if (action === "edit-habit") {
      openHabitDialog(id);
    } else if (action === "complete-habit") {
      await api(`/api/habits/${encodeURIComponent(id)}/complete`, { method: "POST", body: "{}" });
      toast("Habit checked in for today.");
      render();
    } else if (action === "delete-habit") {
      const habit = state.habits.find((item) => item.id === id);
      if (!window.confirm(`Delete “${habit?.name || "this habit"}” and its streak history?`)) return;
      await api(`/api/habits/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("Habit deleted.");
      render();
    } else if (action === "close-modal") {
      closeModal();
    } else if (action === "focus-toggle") {
      startTimer();
    } else if (action === "focus-reset") {
      resetTimer();
    } else if (action === "timer-preset") {
      if (state.timerRunning) return;
      state.timerMinutes = Number(control.dataset.minutes);
      state.timerRemaining = state.timerMinutes * 60;
      state.timerRecorded = false;
      await renderFocus();
    } else if (action === "test-sound") {
      const sound = document.querySelector('[name="sound"]')?.value || state.settings?.sound || "chime";
      playTone(sound);
    } else if (action === "notification-toggle") {
      const input = control.parentElement.querySelector('[name="notificationsEnabled"]');
      let enabled = input.value !== "true";
      if (enabled) {
        if (!("Notification" in window)) {
          toast("This browser does not support notifications.", "error");
          return;
        }
        if (Notification.permission === "default") {
          const permission = await Notification.requestPermission();
          enabled = permission === "granted";
        } else {
          enabled = Notification.permission === "granted";
        }
        if (!enabled) toast("Notification permission was not granted.", "error");
      }
      input.value = String(enabled);
      control.setAttribute("aria-checked", String(enabled));
    } else if (action === "resend-code") {
      const response = await api("/api/auth/resend", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingEmail }),
      });
      toast(response.message);
    } else if (action === "logout") {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      window.clearInterval(state.reminderInterval);
      state.reminderInterval = null;
      window.clearInterval(state.timerInterval);
      state.timerInterval = null;
      state.timerRunning = false;
      state.user = null;
      state.settings = null;
      await refreshSession();
      state.authMode = "login";
      render();
    } else if (action === "retry-page") {
      render();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function handleSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  formError(form, "");
  setFormBusy(form, true);
  try {
    if (kind === "register") {
      const data = new FormData(form);
      const email = String(data.get("email") || "").trim().toLowerCase();
      const result = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password: String(data.get("password") || "") }),
      });
      setAuthMode("login");
    toast("Account created! Please sign in", "success");
    render();
    return;
  
      
    } else if (kind === "login") {
      const data = new FormData(form);
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: String(data.get("email") || "").trim().toLowerCase(),
          password: String(data.get("password") || ""),
        }),
      });
      await refreshSession();
      state.page = "today";
      render();
    } else if (kind === "verify") {
      const data = new FormData(form);
      const result = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ email: state.pendingEmail, code: String(data.get("code") || "").trim() }),
      });
      state.user = result.user;
      state.csrfToken = result.csrfToken;
      await refreshSession();
      state.page = "today";
      render();
      toast("Your email is verified. Welcome to Daymark.");
    } else if (kind === "task") {
      const id = form.dataset.id;
      const existing = state.tasks.find((item) => item.id === id);
      const payload = taskPayload(form, existing);
      if (id) {
        await api(`/api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("Task updated.");
      } else {
        await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
        toast("Task added to your list.");
      }
      closeModal();
      render();
    } else if (kind === "project") {
      const id = form.dataset.id;
      const data = new FormData(form);
      const payload = {
        name: String(data.get("name") || "").trim(),
        description: String(data.get("description") || "").trim() || null,
        color: String(data.get("color") || "#6c9a7e"),
      };
      if (id) {
        await api(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("Project updated.");
      } else {
        await api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
        toast("Project created.");
      }
      closeModal();
      render();
    } else if (kind === "habit") {
      const id = form.dataset.id;
      const data = new FormData(form);
      const payload = { name: String(data.get("name") || "").trim(), targetPerWeek: Number(data.get("targetPerWeek")) };
      if (id) {
        await api(`/api/habits/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("Habit updated.");
      } else {
        await api("/api/habits", { method: "POST", body: JSON.stringify(payload) });
        toast("Habit added.");
      }
      closeModal();
      render();
    } else if (kind === "settings") {
      const data = new FormData(form);
      const enabled = String(data.get("notificationsEnabled")) === "true";
      const payload = {
        sound: String(data.get("sound")),
        notificationsEnabled: enabled,
        dailyCapacityMinutes: Number(data.get("dailyCapacityMinutes")),
        energyWindow: String(data.get("energyWindow")),
      };
      const settings = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      state.settings = settings;
      toast("Your preferences are saved.");
      render();
    }
  } catch (error) {
    formError(form, error.message);
    if (kind === "register" && error.status === 429) toast(error.message, "error");
  } finally {
    if (form.isConnected) setFormBusy(form, false);
  }
}

function handleInput(event) {
  if (event.target.matches("[data-task-search]")) {
    state.taskSearch = event.target.value;
    setFilterResults();
  }
}

function handleChange(event) {
  if (event.target.matches("[data-task-filter]")) {
    state.taskStatusFilter = event.target.value;
    setFilterResults();
  }
  if (event.target.matches("#focus-task")) {
    state.timerTaskId = event.target.value;
  }
}

function handleKeydown(event) {
  if (event.key === "Escape") closeModal();
  if ((event.key === "Enter" || event.key === " ") && event.target.matches('[data-action="edit-task"][role="button"]')) {
    event.preventDefault();
    event.target.click();
  }
}

async function bootstrap() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleChange);
  document.addEventListener("keydown", handleKeydown);
  try {
    await refreshSession();
    const requestedPage = location.hash.replace(/^#/, "");
    state.page = PAGE_NAMES[requestedPage] ? requestedPage : "today";
    render();
  } catch (error) {
    root.innerHTML = `<main class="auth-screen"><section class="auth-story"><div class="brand-lockup"><span class="brand-glyph">D</span><span>daymark</span></div><div class="auth-copy"><div class="eyebrow">A little more room in your day</div><h1>Make space for what matters.</h1><p>Daymark could not connect to its local service. Restart the Python app and try again.</p></div></section><section class="auth-panel"><div class="auth-card"><div class="eyebrow">Connection issue</div><h2>Daymark is taking a moment</h2><p>${escapeHtml(error.message)}</p><button class="btn" data-action="retry-page">Try again</button></div></section></main>`;
    root.setAttribute("aria-busy", "false");
  }
}

bootstrap();
