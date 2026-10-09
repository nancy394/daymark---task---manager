import os
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
os.environ.setdefault("SECRET_KEY", "test-only-secret-not-for-production")

import app as daymark


class DaymarkApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_env = {
            key: os.environ.get(key)
            for key in (
                "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD",
                "SMTP_FROM", "SMTP_USE_TLS", "SMTP_USE_SSL",
            )
        }
        os.environ.update(
            {
                "SMTP_HOST": "mail.example.test",
                "SMTP_PORT": "587",
                "SMTP_USERNAME": "test-sender",
                "SMTP_PASSWORD": "test-only",
                "SMTP_FROM": "daymark@example.test",
                "SMTP_USE_TLS": "true",
                "SMTP_USE_SSL": "false",
            }
        )
        daymark.app.config.update(
            TESTING=True,
            SECRET_KEY="test-only-secret-not-for-production",
            DATABASE_PATH=str(Path(self.temp_dir.name) / "daymark.sqlite3"),
        )
        daymark.init_db()
        self.mailbox = {}
        self.mailer = patch.object(
            daymark, "send_verification_email", side_effect=self.capture_email
        )
        self.mailer.start()
        self.addCleanup(self.mailer.stop)
        self.addCleanup(self.temp_dir.cleanup)
        self.addCleanup(self.restore_mail_environment)

    def restore_mail_environment(self):
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def capture_email(self, email, code):
        self.mailbox[email] = code

    def call(self, client, path, method="GET", data=None, csrf=True):
        headers = {"X-Client-Timezone": "Asia/Kolkata"}
        if method not in {"GET", "HEAD"} and csrf:
            headers["X-CSRF-Token"] = client.get("/api/auth/session").json["csrfToken"]
        return client.open(
            path,
            method=method,
            json=data,
            headers=headers,
        )

    def register_and_verify(self, client, email, password="correct-horse-battery"):
        response = self.call(
            client,
            "/api/auth/register",
            "POST",
            {"email": email, "password": password},
        )
        self.assertEqual(response.status_code, 202, response.get_json())
        self.assertIn(email, self.mailbox)
        response = self.call(
            client,
            "/api/auth/verify",
            "POST",
            {"email": email, "code": self.mailbox[email]},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["user"]

    def test_email_verification_blocks_unverified_login(self):
        client = daymark.app.test_client()
        email = "reader@example.test"
        result = self.call(
            client,
            "/api/auth/register",
            "POST",
            {"email": email, "password": "correct-horse-battery"},
        )
        self.assertEqual(result.status_code, 202)
        self.assertEqual(self.mailbox[email].__len__(), 6)

        login = self.call(
            client,
            "/api/auth/login",
            "POST",
            {"email": email, "password": "correct-horse-battery"},
        )
        self.assertEqual(login.status_code, 403)
        wrong_code = self.call(
            client,
            "/api/auth/verify",
            "POST",
            {"email": email, "code": "000000" if self.mailbox[email] != "000000" else "111111"},
        )
        self.assertEqual(wrong_code.status_code, 400)

        verified = self.call(
            client,
            "/api/auth/verify",
            "POST",
            {"email": email, "code": self.mailbox[email]},
        )
        self.assertEqual(verified.status_code, 200)
        self.assertEqual(verified.json["user"]["email"], email)
        duplicate = self.call(
            client,
            "/api/auth/register",
            "POST",
            {"email": email, "password": "correct-horse-battery"},
        )
        self.assertEqual(duplicate.status_code, 409)
        signed_out = self.call(client, "/api/auth/logout", "POST", {})
        self.assertEqual(signed_out.status_code, 200)
        signed_in = self.call(
            client,
            "/api/auth/login",
            "POST",
            {"email": email, "password": "correct-horse-battery"},
        )
        self.assertEqual(signed_in.status_code, 200)

    def test_plain_html_styles_and_javascript_are_served(self):
        client = daymark.app.test_client()
        page = client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'id="app"', page.data)
        self.assertIn(b"/static/css/styles.css", page.data)
        self.assertIn(b"/static/js/app.js", page.data)
        css = client.get("/static/css/styles.css")
        js = client.get("/static/js/app.js")
        self.assertEqual(css.status_code, 200)
        self.assertEqual(js.status_code, 200)
        css.close()
        js.close()

    def test_planning_projects_recurring_tasks_habits_and_focus(self):
        client = daymark.app.test_client()
        self.register_and_verify(client, "planner@example.test")

        project = self.call(
            client,
            "/api/projects",
            "POST",
            {"name": "Garden", "description": "A little outdoor project", "color": "#6c9a7e"},
        )
        self.assertEqual(project.status_code, 201, project.get_json())
        project_id = project.json["id"]

        task = self.call(
            client,
            "/api/tasks",
            "POST",
            {
                "title": "Plant the herbs",
                "status": "todo",
                "priority": "high",
                "projectId": project_id,
                "dueDate": date.today().isoformat(),
                "estimateMinutes": 50,
                "energyLevel": "high",
                "preferredTime": "morning",
                "recurrence": "weekly",
                "tags": ["outside", "quick win"],
                "subtasks": [{"title": "Choose pots"}, {"title": "Get soil"}],
            },
        )
        self.assertEqual(task.status_code, 201, task.get_json())
        self.assertEqual(task.json["tags"], ["outside", "quick win"])
        self.assertEqual(len(task.json["subtasks"]), 2)

        settings = self.call(
            client,
            "/api/settings",
            "PUT",
            {
                "sound": "rising",
                "notificationsEnabled": True,
                "dailyCapacityMinutes": 240,
                "energyWindow": "morning",
            },
        )
        self.assertEqual(settings.status_code, 200, settings.get_json())
        self.assertEqual(settings.json["timezone"], "Asia/Kolkata")

        before = self.call(client, "/api/dashboard")
        self.assertEqual(before.json["dueTodayCount"], 1)
        self.assertEqual(before.json["minutesPlanned"], 50)
        self.assertEqual(before.json["minutesCapacity"], 240)

        complete = self.call(
            client,
            f"/api/tasks/{task.json['id']}",
            "PATCH",
            {"status": "done"},
        )
        self.assertEqual(complete.status_code, 200, complete.get_json())
        tasks = self.call(client, "/api/tasks").json
        self.assertEqual(len(tasks), 2)
        next_task = next(item for item in tasks if item["status"] == "todo")
        self.assertEqual(next_task["dueDate"], (date.today() + timedelta(days=7)).isoformat())
        self.assertTrue(all(not subtask["done"] for subtask in next_task["subtasks"]))

        habit = self.call(
            client,
            "/api/habits",
            "POST",
            {"name": "Go outside", "targetPerWeek": 5},
        )
        self.assertEqual(habit.status_code, 201, habit.get_json())
        checked = self.call(
            client,
            f"/api/habits/{habit.json['id']}/complete",
            "POST",
            {},
        )
        self.assertEqual(checked.status_code, 200, checked.get_json())
        self.assertEqual(checked.json["streak"], 1)

        focus = self.call(
            client,
            "/api/focus-sessions",
            "POST",
            {"durationMinutes": 25, "taskId": task.json["id"]},
        )
        self.assertEqual(focus.status_code, 201, focus.get_json())
        dashboard = self.call(client, "/api/dashboard")
        self.assertEqual(dashboard.json["completedCount"], 1)
        self.assertEqual(dashboard.json["currentStreak"], 1)
        self.assertEqual(dashboard.json["focusMinutesToday"], 25)

    def test_user_data_is_private_and_csrf_is_required(self):
        owner = daymark.app.test_client()
        other = daymark.app.test_client()
        self.register_and_verify(owner, "owner@example.test")
        task = self.call(
            owner,
            "/api/tasks",
            "POST",
            {"title": "Private note", "status": "todo"},
        )
        self.assertEqual(task.status_code, 201)

        self.register_and_verify(other, "other@example.test")
        self.assertEqual(self.call(other, "/api/tasks").json, [])
        stolen = self.call(
            other,
            f"/api/tasks/{task.json['id']}",
            "PATCH",
            {"status": "done"},
        )
        self.assertEqual(stolen.status_code, 404)
        missing_csrf = self.call(
            other,
            "/api/tasks",
            "POST",
            {"title": "Rejected write"},
            csrf=False,
        )
        self.assertEqual(missing_csrf.status_code, 403)

    def test_registration_fails_clearly_without_mail_configuration(self):
        os.environ.pop("SMTP_HOST", None)
        client = daymark.app.test_client()
        result = self.call(
            client,
            "/api/auth/register",
            "POST",
            {"email": "no-mail@example.test", "password": "correct-horse-battery"},
        )
        self.assertEqual(result.status_code, 503)
        self.assertIn("SMTP", result.json["error"])

    def test_invalid_enum_payloads_return_client_errors(self):
        client = daymark.app.test_client()
        self.register_and_verify(client, "validation@example.test")
        bad_task = self.call(
            client,
            "/api/tasks",
            "POST",
            {"title": "Malformed status", "status": ["not", "a", "status"]},
        )
        self.assertEqual(bad_task.status_code, 400)
        bad_settings = self.call(
            client,
            "/api/settings",
            "PUT",
            {
                "sound": ["not", "a", "sound"],
                "notificationsEnabled": True,
                "dailyCapacityMinutes": 240,
                "energyWindow": "morning",
            },
        )
        self.assertEqual(bad_settings.status_code, 400)


if __name__ == "__main__":
    unittest.main()
