from __future__ import annotations

import asyncio
import inspect
import json
import os
import sys
from collections.abc import Callable
from typing import Any, get_args, get_origin, get_type_hints

import tools


TOOL_FUNCTIONS: dict[str, Callable[..., Any]] = {
    name: getattr(tools, name)
    for name in (
        "context_workspace_health",
        "context_workspace_hermes_status",
        "context_workspace_query_memory",
        "context_workspace_query_project_memory",
        "context_workspace_store_memory",
        "context_workspace_delete_memory",
        "context_workspace_recent_memory",
        "context_workspace_list_agent_sessions",
        "context_workspace_summarize_agent_sessions",
        "context_workspace_spawn_agent",
        "context_workspace_spawn_terminal",
        "context_workspace_list_runs",
        "context_workspace_get_run",
        "context_workspace_cancel_run",
        "context_workspace_read_artifact",
        "context_workspace_read_agent_session",
        "context_workspace_wait_for_run",
        "context_workspace_write_recall_cache",
        "context_workspace_read_recall_cache",
        "context_workspace_clear_recall_cache",
    )
}


def main() -> None:
    _debug("server starting")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            _debug(f"request {request.get('method')}")
            response = _handle_request(request)
        except Exception as exc:
            _debug(f"error {exc}")
            response = _error_response(None, -32603, str(exc))
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            _debug("response written")


def _handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": request.get("params", {}).get("protocolVersion", "2025-11-25"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "context_workspace", "version": "0.1.0"},
            },
        }
    if method == "notifications/initialized":
        return None
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": [_tool_schema(fn) for fn in TOOL_FUNCTIONS.values()]}}
    if method == "tools/call":
        params = request.get("params", {})
        return _call_tool_response(request_id, params.get("name"), params.get("arguments") or {})

    return _error_response(request_id, -32601, f"Unsupported method: {method}")


def _call_tool_response(request_id: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    tool = TOOL_FUNCTIONS.get(name)
    if tool is None:
        return _error_response(request_id, -32602, f"Unknown tool: {name}")
    try:
        result = asyncio.run(tool(**arguments))
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": text}], "isError": False},
        }
    except Exception as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True},
        }


def _error_response(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def _tool_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    signature = inspect.signature(fn)
    type_hints = get_type_hints(fn)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, parameter in signature.parameters.items():
        annotation = type_hints.get(name, parameter.annotation)
        properties[name] = _json_schema_for_annotation(annotation)
        if parameter.default is inspect.Parameter.empty:
            required.append(name)
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return {
        "name": fn.__name__,
        "description": inspect.getdoc(fn) or "",
        "inputSchema": schema,
    }


def _json_schema_for_annotation(annotation: Any) -> dict[str, Any]:
    if annotation is inspect.Signature.empty:
        return {}
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin is list:
        return {"type": "array", "items": _json_schema_for_annotation(args[0]) if args else {}}
    if origin is dict:
        return {"type": "object"}
    if origin is type(None):
        return {"type": "null"}
    if origin is not None and type(None) in args:
        non_null = [arg for arg in args if arg is not type(None)]
        schema = _json_schema_for_annotation(non_null[0]) if non_null else {}
        return {"anyOf": [schema, {"type": "null"}]}
    if annotation is str:
        return {"type": "string"}
    if annotation is int:
        return {"type": "integer"}
    if annotation is float:
        return {"type": "number"}
    if annotation is bool:
        return {"type": "boolean"}
    return {}


def _debug(message: str) -> None:
    if os.environ.get("CONTEXT_WORKSPACE_MCP_DEBUG"):
        print(f"context_workspace_mcp: {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
