#!/usr/bin/env python3
"""Export the backend's customer tool catalog to lib/generated/backend-tools.json.

The in-product agent's tools are defined in respan-backend
(admin/mcp_server/*, exposed to customers through
utils.mcp.tool_bridge.register_tools). This copies each tool's name,
description and input schema verbatim, so the tools this server implements on
top of them describe themselves exactly as the agent's do. Only the contract
is exported; the HTTP calls are written by hand in lib/.

Run from a backend checkout with its virtualenv:

    cd <respan-backend>
    ./.venv/bin/python <respan-mcp>/scripts/export_backend_tools.py \
        --out <respan-mcp>/lib/generated/backend-tools.json

The tool registry never touches Django's database or settings, but two of its
imports pull in modules that do, so they are stubbed for this export instead of
configuring a full Django environment.
"""

import json
import os
import re
import sys
import types

sys.path.insert(0, os.getcwd())

_psycogreen = types.ModuleType("psycogreen")
_psycogreen_gevent = types.ModuleType("psycogreen.gevent")
_psycogreen_gevent.patch_psycopg = lambda: None
sys.modules["psycogreen"] = _psycogreen
sys.modules["psycogreen.gevent"] = _psycogreen_gevent
_exceptions = types.ModuleType("utils.exceptions")
_exceptions.extract_http_error_detail = lambda *args, **kwargs: ""
sys.modules["utils.exceptions"] = _exceptions

from admin.mcp_server import core  # noqa: E402
from utils.mcp.tool_bridge import (  # noqa: E402
    AGENT_READ_ONLY_TOOLS,
    AGENT_SAFE_DOMAINS,
    register_tools,
)

OUT_PATH = "lib/generated/backend-tools.json"
if "--out" in sys.argv:
    OUT_PATH = sys.argv[sys.argv.index("--out") + 1]

# The agent-only activity label: it drives an in-product UI affordance and is
# never sent upstream.
ACTIVITY = core.TOOL_ACTIVITY_PARAM_KEY

# Descriptions are written for an internal registry. This repository and the
# endpoint it serves are public, so sentences naming internal paths or
# staff-only behavior are dropped, and the export fails if any survive.
INTERNAL_PATTERNS = (
    re.compile(r"\b[\w.-]+/[\w./-]*\.(?:md|py)\b"),
    re.compile(r"superadmin", re.IGNORECASE),
    re.compile(r"\bstaff[- _]only\b", re.IGNORECASE),
)
# The agent loads tools on demand through tool_search; no client of this
# server has it, so instructions to call it cannot be followed here.
DANGLING_PATTERNS = (re.compile(r"\btool_search\b"),)


def scrub(text):
    if not text:
        return text
    sentences = re.split(r"(?<=[.!?])\s+|\n", text)
    kept = [
        sentence
        for sentence in sentences
        if not any(p.search(sentence) for p in INTERNAL_PATTERNS + DANGLING_PATTERNS)
    ]
    cleaned = " ".join(sentence.strip() for sentence in kept if sentence.strip())
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def scrub_schema(node):
    if isinstance(node, dict):
        return {
            key: scrub(value) if key == "description" and isinstance(value, str) else scrub_schema(value)
            for key, value in node.items()
        }
    if isinstance(node, list):
        return [scrub_schema(item) for item in node]
    return node


tools, _ = register_tools(sorted(AGENT_SAFE_DOMAINS, key=str), client=None)
exported = []
for tool in sorted(tools, key=lambda t: t["function"]["name"]):
    function = tool["function"]
    schema = json.loads(json.dumps(function["parameters"]))
    schema.get("properties", {}).pop(ACTIVITY, None)
    if ACTIVITY in schema.get("required", []):
        schema["required"] = [key for key in schema["required"] if key != ACTIVITY]
    exported.append(
        {
            "name": function["name"],
            "description": scrub(function["description"]),
            "inputSchema": scrub_schema(schema),
            "readOnly": function["name"] in AGENT_READ_ONLY_TOOLS,
        }
    )

blob = json.dumps({"tools": exported}, indent=1, ensure_ascii=False)
offenders = sorted({m.group(0) for p in INTERNAL_PATTERNS for m in p.finditer(blob)})
if offenders:
    raise SystemExit("refusing to export, internal references present: " + ", ".join(offenders))

with open(OUT_PATH, "w") as handle:
    handle.write(blob + "\n")
print(f"exported {len(exported)} tools ({sum(t['readOnly'] for t in exported)} read-only) to {OUT_PATH}")
