"""Unique codenames + multi-device sessions.

Codenames: 1,600-combo pool, uniqueness enforced at signup
(core.generate_unique_codename) and retroactively (server.dedupe_codenames —
one-shot migration unique_codenames_v1). Demos keep their canonical names.

Sessions: every sign-in mints its OWN token (30-day TTL); logging in on a
second device must never log out the first, and logging out one device must
only end that device's session."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com"
).rstrip("/")
TOKEN = os.environ.get("TEST_SESSION_TOKEN", "")
db = MongoClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]


def _auth(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_multi_device_sessions_coexist_and_logout_is_per_device():
    uid = f"tt-multidev-{uuid.uuid4().hex[:8]}"
    tok_a = f"sttest_devA_{uuid.uuid4().hex}"
    tok_b = f"sttest_devB_{uuid.uuid4().hex}"
    db.users.insert_one({
        "id": uid, "email": f"{uid}@example.com", "codename": f"Multi Dev {uid[-4:]}",
        "handle": None, "is_demo": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    for tok in (tok_a, tok_b):
        db.user_sessions.insert_one({
            "user_id": uid, "session_token": tok,
            "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
            "created_at": datetime.now(timezone.utc),
        })
    try:
        # both "devices" are signed in simultaneously
        ra = requests.get(f"{BASE_URL}/api/auth/me", headers=_auth(tok_a), timeout=15)
        rb = requests.get(f"{BASE_URL}/api/auth/me", headers=_auth(tok_b), timeout=15)
        assert ra.status_code == 200 and ra.json()["user"]["id"] == uid, ra.text
        assert rb.status_code == 200 and rb.json()["user"]["id"] == uid, rb.text

        # logging out device A must not touch device B
        r = requests.post(f"{BASE_URL}/api/auth/logout", headers=_auth(tok_a), timeout=15)
        assert r.status_code == 200, r.text
        assert requests.get(f"{BASE_URL}/api/auth/me", headers=_auth(tok_a), timeout=15).status_code == 401
        assert requests.get(f"{BASE_URL}/api/auth/me", headers=_auth(tok_b), timeout=15).status_code == 200
    finally:
        db.users.delete_one({"id": uid})
        db.user_sessions.delete_many({"user_id": uid})


def test_session_ttl_is_30_days():
    from core import SESSION_TTL
    assert SESSION_TTL.days == 30


def test_codename_pool_is_large():
    from core import CODENAME_ADJ, CODENAME_NOUN
    assert len(CODENAME_ADJ) * len(CODENAME_NOUN) >= 1600
    assert len(set(CODENAME_ADJ)) == len(CODENAME_ADJ)
    assert len(set(CODENAME_NOUN)) == len(CODENAME_NOUN)


def test_unique_codename_generator_and_dedupe_migration():
    """One asyncio.run covering both async pieces (motor binds to one loop):
    1. generator falls back to a numeric suffix when every combo is taken;
    2. dedupe_codenames renames the NEWER of two real users sharing a name."""
    import asyncio

    async def scenario():
        import core
        import server
        from core import db as adb

        # -- generator fallback: shrink the pool to a single taken combo
        orig_adj, orig_noun = core.CODENAME_ADJ, core.CODENAME_NOUN
        clash_id = f"tt-clash-{uuid.uuid4().hex[:8]}"
        core.CODENAME_ADJ, core.CODENAME_NOUN = ["Clash"], ["Test"]
        try:
            await adb.users.insert_one({"id": clash_id, "codename": "Clash Test", "is_demo": False})
            name = await core.generate_unique_codename()
            assert name.startswith("Clash Test ") and name != "Clash Test", name
        finally:
            core.CODENAME_ADJ, core.CODENAME_NOUN = orig_adj, orig_noun
            await adb.users.delete_one({"id": clash_id})

        # -- dedupe: older keeps the name, newer gets renamed
        old_id = f"tt-dupold-{uuid.uuid4().hex[:8]}"
        new_id = f"tt-dupnew-{uuid.uuid4().hex[:8]}"
        shared = f"Dup Pair {uuid.uuid4().hex[:6]}"
        try:
            await adb.users.insert_one({"id": old_id, "codename": shared, "is_demo": False,
                                        "created_at": "2026-01-01T00:00:00+00:00"})
            await adb.users.insert_one({"id": new_id, "codename": shared, "is_demo": False,
                                        "created_at": "2026-06-01T00:00:00+00:00"})
            fixed = await server.dedupe_codenames()
            assert fixed >= 1
            old = await adb.users.find_one({"id": old_id})
            new = await adb.users.find_one({"id": new_id})
            assert old["codename"] == shared, "oldest account must keep its codename"
            assert new["codename"] != shared, "newer duplicate must be renamed"
        finally:
            await adb.users.delete_many({"id": {"$in": [old_id, new_id]}})

    asyncio.run(scenario())
