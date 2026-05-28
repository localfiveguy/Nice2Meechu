# Auth-Gated App Testing Playbook (Nice2Meechu)

Use Google OAuth (Emergent-managed). For testing without going through real Google sign-in,
seed the DB directly with a test session and use Bearer auth.

## Step 1: Create Test User & Session
```bash
mongosh --eval "
use('test_database');
var userId = 'test-user-' + Date.now();
var sessionToken = 'test_session_' + Date.now();
db.users.insertOne({
  id: userId,
  email: 'test.user.' + Date.now() + '@example.com',
  name: 'Test User',
  picture: 'https://via.placeholder.com/150',
  codename: 'Velvet Fox',
  handle: null,
  vibes: [],
  language: 'en',
  avatar_emoji: '🌙',
  created_at: new Date()
});
db.user_sessions.insertOne({
  user_id: userId,
  session_token: sessionToken,
  expires_at: new Date(Date.now() + 7*24*60*60*1000),
  created_at: new Date()
});
print('Session token: ' + sessionToken);
print('User ID: ' + userId);
"
```

## Step 2: Test Backend API (Bearer auth)
```bash
curl -X GET "{BACKEND_URL}/api/auth/me" -H "Authorization: Bearer YOUR_SESSION_TOKEN"
curl -X GET "{BACKEND_URL}/api/feed" -H "Authorization: Bearer YOUR_SESSION_TOKEN"
```

## Step 3: Browser Testing (Cookie auth)
```python
await page.context.add_cookies([{
    "name": "session_token",
    "value": "YOUR_SESSION_TOKEN",
    "domain": "your-app.com",
    "path": "/",
    "httpOnly": True,
    "secure": True,
    "sameSite": "None"
}])
await page.goto("https://your-app.com")
```

## Quick clean
```bash
mongosh --eval "
use('test_database');
db.users.deleteMany({email: /test\.user\./});
db.user_sessions.deleteMany({session_token: /test_session/});
"
```

## Checklist
- [x] User document has `id` field (custom UUID; MongoDB's `_id` excluded with projection)
- [x] Session `user_id` matches user's `id` exactly
- [x] All queries use `{"_id": 0}` projection
- [x] Backend `current_user` resolves cookie first, then Bearer header
- [x] /api/auth/me returns user data when authenticated

## Success Indicators
- /api/auth/me returns user
- Feed loads, no redirect to sign-in
- Match + chat round-trip works
