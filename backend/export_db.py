"""Founder-only full database export, used once to migrate off Emergent hosting.

Open while signed in as an ADMIN_EMAILS account:
    https://nice2meechu.com/api/admin/export-db?confirm=EXPORT

Downloads one JSON file (MongoDB Extended JSON, so dates/ObjectIds survive)
containing every collection, its documents, and its index definitions.
Anyone not in ADMIN_EMAILS gets 403. The export contains personal data —
store it privately and delete it after the migration is confirmed.
"""
from datetime import datetime, timezone

from bson import json_util
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from admin import _require_admin
from auth import current_user
from core import db, logger

router = APIRouter()


@router.get("/admin/export-db")
async def admin_export_db(confirm: str = "", user=Depends(current_user)):
    _require_admin(user)
    if confirm != "EXPORT":
        raise HTTPException(400, "Add ?confirm=EXPORT to the address to download the export")

    names = sorted(n for n in await db.list_collection_names() if not n.startswith("system."))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    logger.warning("admin export-db started by %s (%d collections)", user.get("email"), len(names))

    async def generate():
        yield '{"format":"nice2meechu-export-v1","db_name":' + json_util.dumps(db.name)
        yield ',"exported_at":' + json_util.dumps(stamp) + ',"collections":{'
        for ci, name in enumerate(names):
            coll = db[name]
            indexes = []
            async for ix in coll.list_indexes():
                d = dict(ix)
                if d.get("name") == "_id_":
                    continue
                indexes.append(d)
            yield ("," if ci else "") + json_util.dumps(name) + ':{"indexes":' + json_util.dumps(indexes) + ',"documents":['
            first = True
            async for doc in coll.find({}):
                yield ("" if first else ",") + json_util.dumps(doc)
                first = False
            yield "]}"
        yield "}}"

    return StreamingResponse(
        generate(),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="nice2meechu-export-{stamp}.json"'},
    )
