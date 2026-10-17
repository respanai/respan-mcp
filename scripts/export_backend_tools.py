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

from admin.mcp_server import TOOLS as ADMIN_TOOLS, core  # noqa: E402
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
# Admin tools the agent bridge withholds whose views still scope a customer to
# their own project or workspace (membership and role checked server-side).
# name -> read-only.
ADMIN_CUSTOMER_TOOLS = {
    "workspace_get": True,
    "workspace_list": True,
    "workspace_member_list": True,
    "workspace_project_list": True,
    "workspace_billing_get": True,
    "workspace_billing_breakdown_get": True,
    "workspace_credit_transaction_list": True,
    "workspace_limit_get": True,
    "workspace_subscription_list": True,
    "workspace_member_invite": False,
    "workspace_member_remove": False,
    "workspace_project_access_grant": False,
    "workspace_project_access_update": False,
    "workspace_project_access_revoke": False,
    "workspace_update": False,
    "join_request_list": True,
    "join_request_approve": False,
    "join_request_deny": False,
    "limit_policy_delete": False,
    "integration_create": False,
    "integration_update": False,
    "integration_activate": False,
    "integration_deactivate": False,
    "integration_delete": False,
    "model_create": False,
    "model_update": False,
    "model_delete": False,
    "foundation_model_get": True,
    "foundation_model_list": True,
    "behavior_guardrail_settings_update": False,
    "behavior_verdict_update": False,
}
# These name their target project in the request: the admin `org` argument is
# published under the product term.
PROJECT_ARGUMENT_TOOLS = ("join_request_list", "join_request_approve", "join_request_deny")
ADMIN_ONLY_ARGUMENTS = ("profile", "org")

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

for tool in ADMIN_TOOLS:
    if tool.name not in ADMIN_CUSTOMER_TOOLS:
        continue
    schema = json.loads(json.dumps(tool.inputSchema))
    properties = schema.get("properties", {})
    if tool.name in PROJECT_ARGUMENT_TOOLS and "org" in properties:
        properties["project"] = properties.pop("org")
        schema["required"] = ["project" if key == "org" else key for key in schema.get("required", [])]
    for key in (ACTIVITY, *ADMIN_ONLY_ARGUMENTS):
        properties.pop(key, None)
    schema["required"] = [key for key in schema.get("required", []) if key in properties]
    exported.append(
        {
            "name": tool.name,
            "description": scrub(tool.description),
            "inputSchema": scrub_schema(schema),
            "readOnly": ADMIN_CUSTOMER_TOOLS[tool.name],
        }
    )
exported.sort(key=lambda tool: tool["name"])

blob = json.dumps({"tools": exported}, indent=1, ensure_ascii=False)
offenders = sorted({m.group(0) for p in INTERNAL_PATTERNS for m in p.finditer(blob)})
if offenders:
    raise SystemExit("refusing to export, internal references present: " + ", ".join(offenders))

with open(OUT_PATH, "w") as handle:
    handle.write(blob + "\n")
print(f"exported {len(exported)} tools ({sum(t['readOnly'] for t in exported)} read-only) to {OUT_PATH}")
