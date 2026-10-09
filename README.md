# Daymark Task Manager — HTML, CSS, JavaScript, and Python
## Team

- Nancy V - Developer & Tester
- Nithika Shree. S - Scrum Master  
- Kirushika T M - Manager

## How to run
pip install -r requirements.txt
python app.py

---
This is the plain web-technology edition of Daymark. It uses a Flask/Python backend, regular HTML templates, CSS, browser JavaScript, and a local SQLite database. It does not require React, TypeScript, Node.js, or PostgreSQL.

## Features

- Email and password registration with a six-digit email verification code
- Login, logout, protected sessions, and private per-user data
- Task creation, editing, deletion, statuses, priorities, dates, reminders, tags, subtasks, and repeat schedules
- Project management and task grouping
- Smart daily plan, capacity overview, energy-aware ordering, and weekly completion history
- Focus timer with recorded sessions
- Habit check-ins, weekly goals, and streaks
- Browser reminders with five selectable synthesized sounds

## Requirements

- Python 3.10 or newer
- An SMTP account that can send verification email

## Start the app

1. Install Python dependencies:

   ```sh
   python3 -m pip install -r requirements.txt
   ```

2. Set a private Flask session key. For example, generate one in a trusted shell and store it in your environment or workspace secrets:

   ```sh
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"
   ```

   Set the result as `SECRET_KEY`. Do not commit the value.

3. Configure email delivery using the SMTP variables below. Registration stays disabled until email sending is configured.
4. Start Daymark:

   ```sh
   python3 app.py
   ```

5. Open `http://localhost:5000`.

The SQLite database is created automatically at `instance/daymark.sqlite3` on first start. Set `DAYMARK_DB_PATH` to choose another location.

## Email verification settings

Set these environment variables outside the source code:

| Variable | Purpose |
| --- | --- |
| `SMTP_HOST` | Outgoing mail server |
| `SMTP_PORT` | Usually `587` for STARTTLS or `465` for SSL |
| `SMTP_USERNAME` | Optional mail account name |
| `SMTP_PASSWORD` | Optional mail account password or app password |
| `SMTP_FROM` | Sender address shown in verification emails |
| `SMTP_USE_TLS` | Use STARTTLS; defaults to `true` |
| `SMTP_USE_SSL` | Use an SSL connection; defaults to `false` |

Daymark emails a time-limited code to the address entered at registration. Registration is not complete until that code is confirmed. Codes expire after 10 minutes, allow at most five attempts, and can be resent once per minute.

## Other environment variables

- `PORT`: HTTP port; defaults to `5000`.
- `APP_ENV=production`: enables secure session cookies and turns off Flask debug mode.
- `SECRET_KEY`: signs sessions and email verification codes.
- `DAYMARK_DB_PATH`: optional SQLite file path.

## Tests

Run the backend and email-verification tests with:

```sh
python3 -m unittest discover -s tests
```

Tests use a temporary SQLite database and a mocked email sender. They do not send real email.

## Reminder behavior

Browser reminders require notification permission and the Daymark page to remain open. The five tones (Chime, Double ping, Digital, Warm bell, and Rising) are synthesized with the Web Audio API; the app has no external audio files.

## Source layout

- `app.py` — Flask routes, email verification, session security, SQLite access, and task logic
- `schema.sql` — database tables and indexes
- `templates/index.html` — page shell and stylesheet/script links
- `static/css/styles.css` — responsive app styling
- `static/js/app.js` — authentication screens and interactive task manager
