import sqlite3
conn = sqlite3.connect('instance/daymark.sqlite3')
cur = conn.cursor()

# Show tables
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print("Tables:", cur.fetchall())

# Try to verify all users (covers all possible column names)
try:
    cur.execute("UPDATE users SET email_verified=1")
    print("Updated email_verified")
except Exception as e:
    print(e)

try:
    cur.execute("UPDATE users SET is_verified=1")
    print("Updated is_verified")
except Exception as e:
    print(e)

try:
    cur.execute("UPDATE users SET verified=1")
    print("Updated verified")
except Exception as e:
    print(e)

try:
    cur.execute("UPDATE users SET is_active=1")
    print("Updated is_active")
except:
    pass

conn.commit()
cur.execute("SELECT * FROM users")
for row in cur.fetchall():
    print("USER:", row)
conn.close()
print("DONE! Now you can login")