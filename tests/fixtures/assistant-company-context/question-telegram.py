"""External Telegram only: execute the real reviewed provider and Telethon.

No connection/session/auth material is used. The disposable backend stand owns
all messages/ids/bytes below; the only replacement is the external SDK client.
Formatting, original revision/sender checks, private stdin, document freezing,
streamed digest read-back and native result envelopes are production code.
"""
import asyncio
import base64
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

data = json.load(sys.stdin)
config = data["configuration"]
root = Path(config["root"]).resolve(strict=True)
assert root.name.startswith("trelio-question-system-")
for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
    assert Path(os.environ[key]).resolve(strict=True) == root
os.environ["TRELIO_CONFIG_HOME"] = str(root / "external-telegram")
provider = Path(config["telegramProviderRoot"]).resolve(strict=True)
assert json.loads((provider / "package.json").read_text())["name"] == "agent-skills-maintainer"
script = provider / "platform-skills/telegram-mtproto/scripts/trelio-telegram.py"
spec = importlib.util.spec_from_file_location("question_real_telegram", script)
M = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = M
spec.loader.exec_module(M)
from telethon import types, utils

owner = int(config["ownerExternalUserId"])
peer = types.User(id=owner, first_name="Synthetic")
date = datetime(2026, 1, 1, tzinfo=timezone.utc)
original = types.Message(id=777, peer_id=types.PeerUser(owner), from_id=types.PeerUser(owner),
                         date=date, message=config["originalText"], out=False)
identity = M.Identity(company_id=config["companyId"], member_id=config["identity"]["assistantId"],
                      connection_id=config["source"]["localAccountId"])
journal = root / "synthetic-provider-sends.jsonl"

def read_rows():
    return [json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []

def message_from_row(row):
    entities = []
    for item in row["entities"]:
        fields = {key: value for key, value in item.items() if key != "_"}
        entities.append(getattr(types, item["_"])(**fields))
    document = row.get("document")
    media = None
    if document is not None:
        native = types.Document(id=1, access_hash=0, file_reference=b"", date=date,
            mime_type="application/octet-stream", size=document["sizeBytes"], dc_id=1,
            attributes=[types.DocumentAttributeFilename(document["fileName"])])
        media = types.MessageMediaDocument(document=native)
    return types.Message(id=row["messageId"], peer_id=types.PeerUser(owner), date=date,
        message=row["text"], out=True, entities=entities, media=media,
        reply_to=types.MessageReplyHeader(reply_to_msg_id=777))

class Client:
    async def connect(self): pass
    async def disconnect(self): pass
    async def is_user_authorized(self): return True
    async def get_me(self): return types.User(id=owner + 1, first_name="Synthetic assistant")
    async def get_entity(self, value):
        assert value == owner
        return peer
    async def get_messages(self, entity, *, ids):
        assert utils.get_peer_id(entity) == owner
        if ids == original.id: return original
        found = [row for row in read_rows() if row["messageId"] == ids]
        return message_from_row(found[0]) if len(found) == 1 else None
    async def __call__(self, request):
        # Presence is the only allowed external non-message operation. No
        # fake ACK, account mutation or hidden secondary provider writer.
        assert type(request).__name__ == "UpdateStatusRequest"
        return True
    async def send_message(self, entity, text, **options):
        assert utils.get_peer_id(entity) == owner and options["reply_to"] == 777
        assert options["parse_mode"] is None
        rows = read_rows()
        assert len(rows) == config.get("replyOrdinal", 1) - 1
        assert not any(row["receiptId"] == data["receiptId"] for row in rows)
        row = {"reference": config["reference"], "receiptId": data["receiptId"],
               "text": text, "messageId": 900 + config.get("replyMessageOrdinal", config.get("replyOrdinal", 1)),
               "entities": [entity.to_dict() for entity in options.get("formatting_entities", [])]}
        if options.get("file") is not None:
            frozen = options["file"]
            assert options["force_document"] is True
            body = frozen.getvalue()
            import hashlib
            row["document"] = {"fileName": frozen.name, "sizeBytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(), "bytes": base64.b64encode(body).decode()}
        with journal.open("x" if not rows else "a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        return message_from_row(row)
    def iter_download(self, native, *, request_size):
        assert request_size == 65_536
        rows = [row for row in read_rows() if row.get("document") is not None]
        body = base64.b64decode(rows[-1]["document"]["bytes"])
        class Stream:
            def __aiter__(self):
                async def chunks():
                    for offset in range(0, len(body), 65_536): yield body[offset:offset + 65_536]
                return chunks()
            async def close(self): pass
        return Stream()

M.build_client = lambda *_args, **_kwargs: Client()

async def main():
    if data.get("describe") or data.get("candidate"):
        binding = await M.overview_binding(Client(), identity, "monitor/v1", M.monitor_account_scope(identity), version="monitor-checkpoint/v1")
        selected = original if data.get("describe") else await Client().get_messages(peer, ids=data["candidate"])
        observed = M.monitor_message(selected, utils, kind="new", channel_peer=owner)
        return {key: observed[key] for key in ("id", "revision")} | {"conversationKey": M.monitor_conversation_key(identity, binding, owner)}
    args = M.build_parser().parse_args(data["arguments"])
    # Only production private stdin is replaced, not the production decoder.
    sys.stdin = SimpleNamespace(buffer=io.BytesIO(base64.b64decode(data["privateInput"])))
    with M.session_lock(identity):
        return await M.command_reply_async(args, identity)

print(json.dumps(asyncio.run(main()), ensure_ascii=False))
