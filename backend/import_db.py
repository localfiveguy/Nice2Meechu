"""One-time database import for the move off Emergent hosting.

Pairs with export_db.py. Visit /api/admin/import-db in a browser, paste the
IMPORT_TOKEN value from the Render dashboard, pick the export JSON file, and
click Import. The file's collections REPLACE the same collections here
(startup tasks may have already seeded demo users into the empty database).

Safety:
  * Disabled unless the IMPORT_TOKEN env var is set (remove it after import).
  * Refuses to run if this database already holds real (non-demo) users,
    so it can never overwrite live data by accident.
"""
import hmac
import os

from bson import json_util
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse

from core import db, logger

router = APIRouter()

IMPORT_TOKEN = os.environ.get("IMPORT_TOKEN", "").strip()
_MAX_BYTES = 50 * 1024 * 1024

_FORM = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nice2Meechu import</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;line-height:1.5}
input,button{font-size:16px;margin:8px 0;width:100%;padding:10px;box-sizing:border-box}
button{background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer}</style></head>
<body><h1>Import Nice2Meechu data</h1>
<p>One-time move from Emergent. Paste the IMPORT_TOKEN from Render, choose the export file, then click Import.</p>
<form method="post" enctype="multipart/form-data">
<label>Import token<input name="token" type="password" required autocomplete="off"></label>
<label>Export file<input name="file" type="file" accept=".json,application/json" required></label>
<button type="submit">Import</button></form></body></html>"""


def _check_enabled():
    if not IMPORT_TOKEN:
        raise HTTPException(404, "Not found")


@router.get("/admin/import-db", response_class=HTMLResponse)
async def import_form():
    _check_enabled()
    return HTMLResponse(_FORM)


@router.post("/admin/import-db", response_class=HTMLResponse)
async def import_db(token: str = Form(...), file: UploadFile = File(...)):
    _check_enabled()
    if not hmac.compare_digest(token.strip(), IMPORT_TOKEN):
        raise HTTPException(403, "Wrong import token")

    real_users = await db.users.count_documents({"is_demo": {"$ne": True}})
    if real_users:
        raise HTTPException(409, f"Refusing: this database already has {real_users} real users")

    raw = await file.read(_MAX_BYTES + 1)
    if len(raw) > _MAX_BYTES:
        raise HTTPException(413, "File too large")
    try:
        data = json_util.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "That file isn't a valid Nice2Meechu export")
    if data.get("format") != "nice2meechu-export-v1" or not isinstance(data.get("collections"), dict):
        raise HTTPException(400, "That file isn't a valid Nice2Meechu export")

    lines = []
    for name, payload in data["collections"].items():
        if name.startswith("system."):
            continue
        docs = payload.get("documents") or []
        await db[name].drop()
        if docs:
            await db[name].insert_many(docs, ordered=False)
        for ix in payload.get("indexes") or []:
            ix = dict(ix)
            keys = list(ix.pop("key").items())
            ix.pop("v", None)
            ix.pop("ns", None)
            try:
                await db[name].create_index(keys, **ix)
            except Exception as exc:  # noqa: BLE001
                logger.warning("import: index %s on %s skipped: %s", ix.get("name"), name, exc)
        lines.append(f"<li>{name}: {len(docs)}</li>")

    logger.warning("import-db completed: %d collections from export %s", len(lines), data.get("exported_at"))
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'><body style='font-family:system-ui;max-width:520px;margin:40px auto'>"
        "<h1>Import complete</h1><p>Records copied per collection:</p><ul>" + "".join(lines) + "</ul>"
        "<p>Now remove IMPORT_TOKEN in Render so this page switches off.</p></body>"
    )
