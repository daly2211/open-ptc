"""
REPL Tool Wrapper for LangGraph Agents

Connects to the open-codemode WebSocket server to provide bidirectional
tool calling. Python functions are registered as tools on the server,
and executed code can call them back through the WebSocket connection.

The server generates TypeScript signatures from the JSON schemas, which
are included in the tool description so the LLM knows how to call them.
"""

import json
import inspect
import logging
import threading
import uuid
from typing import Callable, Any

import websocket
from langchain_core.tools import tool

log = logging.getLogger("repl_tool")


def configure_logging(level: int | str = logging.WARNING) -> None:
    """Configure repl_tool log level.

    Args:
        level: logging.DEBUG, logging.INFO, logging.WARNING, etc.
               or a string like "DEBUG", "INFO", "WARNING".
    """
    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.WARNING)
    logger = logging.getLogger("repl_tool")
    logger.setLevel(level)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("[%(name)s %(levelname)s] %(message)s"))
        logger.addHandler(handler)


# -- Validation --------------------------------------------------------------

def _validate_function(func: Callable) -> None:
    """Reject LangGraph tools and other non-plain functions."""
    if hasattr(func, "name") and hasattr(func, "description") and hasattr(func, "args_schema"):
        raise TypeError(
            f"'{func.__name__}' is a LangGraph tool. Pass the raw function instead, "
            f"or use func.__wrapped__ to unwrap it."
        )
    if not callable(func):
        raise TypeError(f"'{func}' is not callable")


# -- JSON Schema generation from Python type hints ----------------------------

_PYTHON_TYPE_TO_JSON: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


def _python_type_to_json_schema(annotation: Any) -> dict:
    """Convert a Python type annotation to a JSON Schema type descriptor."""
    if annotation is inspect.Parameter.empty or annotation is Any:
        return {}

    # Handle Optional[X] / X | None
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", ())

    if origin is type(int | str):  # UnionType (3.10+)
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _python_type_to_json_schema(non_none[0])
        return {}

    # typing.Union
    import typing
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return _python_type_to_json_schema(non_none[0])
        return {}

    # typing.List[X]
    if origin is list:
        items = _python_type_to_json_schema(args[0]) if args else {}
        schema: dict = {"type": "array"}
        if items:
            schema["items"] = items
        return schema

    # typing.Dict[K, V]
    if origin is dict:
        return {"type": "object"}

    # Plain type
    json_type = _PYTHON_TYPE_TO_JSON.get(annotation)
    if json_type:
        return {"type": json_type}

    return {}


def _func_to_json_schema(func: Callable) -> dict:
    """
    Generate a JSON Schema for a function's input parameters.
    
    Inspects type hints, defaults, and docstring to build the schema.
    """
    sig = inspect.signature(func)
    properties: dict[str, dict] = {}
    required: list[str] = []

    # Parse docstring for param descriptions
    param_docs = _parse_param_docs(func)

    for name, param in sig.parameters.items():
        prop: dict = {}

        # Type
        type_schema = _python_type_to_json_schema(param.annotation)
        prop.update(type_schema)

        # Description from docstring
        if name in param_docs:
            prop["description"] = param_docs[name]

        # Default value
        if param.default is not inspect.Parameter.empty:
            prop["default"] = param.default
        else:
            required.append(name)

        # Enum from Literal type hint
        origin = getattr(param.annotation, "__origin__", None)
        import typing
        if origin is typing.Literal:
            prop["enum"] = list(param.annotation.__args__)
            prop["type"] = "string"

        properties[name] = prop

    schema: dict = {
        "type": "object",
        "properties": properties,
    }
    if required:
        schema["required"] = required

    return schema


def _parse_param_docs(func: Callable) -> dict[str, str]:
    """Extract parameter descriptions from a function's docstring."""
    doc = inspect.getdoc(func)
    if not doc:
        return {}

    descriptions: dict[str, str] = {}
    in_args = False

    for line in doc.split("\n"):
        stripped = line.strip()
        if stripped.lower().startswith("args:") or stripped.lower().startswith("parameters:"):
            in_args = True
            continue
        if stripped.lower().startswith("returns:") or stripped.lower().startswith("raises:"):
            in_args = False
            continue
        if in_args and ":" in stripped:
            parts = stripped.split(":", 1)
            param_name = parts[0].strip()
            param_desc = parts[1].strip()
            descriptions[param_name] = param_desc

    return descriptions


def _return_type_to_json_schema(func: Callable) -> dict | None:
    """Generate JSON Schema for a function's return type."""
    sig = inspect.signature(func)
    if sig.return_annotation is inspect.Parameter.empty:
        return None
    
    return_type = sig.return_annotation
    schema = _python_type_to_json_schema(return_type)
    
    # If we got a schema, wrap it properly
    if schema:
        return schema
    
    return None


def _func_to_tool_descriptor(func: Callable) -> dict:
    """Convert a Python function to a ClientToolDescriptor for WS registration."""
    doc = inspect.getdoc(func) or ""
    first_line = doc.split("\n")[0].strip() if doc else func.__name__

    descriptor = {
        "name": func.__name__,
        "description": first_line,
        "inputSchema": _func_to_json_schema(func),
    }
    
    # Add output schema if return type hint is present
    output_schema = _return_type_to_json_schema(func)
    if output_schema is not None:
        descriptor["outputSchema"] = output_schema
    
    return descriptor


# -- WebSocket Client ---------------------------------------------------------

class _WsBridge:
    """
    Internal WebSocket client that manages the bidirectional connection.
    
    Handles: connect, register tools, get signatures, execute code,
    and respond to tool_call messages from the server.
    """

    def __init__(self, ws_url: str, functions: list[Callable], timeout: int):
        self.ws_url = ws_url
        self.functions = {f.__name__: f for f in functions}
        self.timeout = timeout
        self.signatures: str | None = None

        self._ws: websocket.WebSocketApp | None = None
        self._thread: threading.Thread | None = None
        self._connected = threading.Event()
        self._pending: dict[str, tuple[threading.Event, dict]] = {}
        self._response_events: dict[str, tuple[threading.Event, dict]] = {}
        self._lock = threading.Lock()
        self._ready = False
        self._error: str | None = None

    # -- Lifecycle ------------------------------------------------------------

    def start(self) -> None:
        """Connect, register tools, and fetch signatures."""
        log.info("Connecting to %s", self.ws_url)
        self._ws = websocket.WebSocketApp(
            self.ws_url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        self._thread = threading.Thread(target=self._ws.run_forever, daemon=True)
        self._thread.start()

        if not self._connected.wait(timeout=10):
            raise ConnectionError(f"Failed to connect to {self.ws_url}")
        if self._error:
            raise ConnectionError(self._error)

        # Register tools
        descriptors = [_func_to_tool_descriptor(f) for f in self.functions.values()]
        log.info("Registering %d tools", len(descriptors))
        log.debug("Tool descriptors: %s", json.dumps(descriptors, indent=2))
        resp = self._send_and_wait("register_tools", {"tools": descriptors}, expect=["success", "error"])
        if resp.get("type") == "error":
            raise RuntimeError(f"Tool registration failed: {resp.get('message')}")

        # Fetch signatures (server generates them from the JSON schemas we sent)
        resp = self._send_and_wait("get_signatures", {}, expect=["signatures", "error"])
        if resp.get("type") == "error":
            raise RuntimeError(f"Failed to get signatures: {resp.get('message')}")
        self.signatures = resp.get("content", "")
        log.debug("Received signatures:\n%s", self.signatures)
        self._ready = True

    def stop(self) -> None:
        """Close the WebSocket connection."""
        if self._ws:
            self._ws.close()

    # -- Send / receive helpers -----------------------------------------------

    def _send(self, msg: dict) -> None:
        if self._ws and self._ws.sock and self._ws.sock.connected:
            self._ws.send(json.dumps(msg))

    def _send_and_wait(self, msg_type: str, payload: dict, expect: list[str], timeout: float = 15) -> dict:
        """Send a message and block until one of the expected response types arrives."""
        wait_id = str(uuid.uuid4())
        event = threading.Event()
        container: dict[str, Any] = {}

        with self._lock:
            self._response_events[wait_id] = (event, container)

        container["_expect"] = expect

        self._send({"type": msg_type, **payload})

        if not event.wait(timeout=timeout):
            with self._lock:
                self._response_events.pop(wait_id, None)
            raise TimeoutError(f"Timeout waiting for {expect} response")

        with self._lock:
            self._response_events.pop(wait_id, None)

        return container.get("_response", {})

    def execute(self, code: str) -> str:
        """Send execute_code and wait for execution_result."""
        if not self._ready:
            return "Error: WebSocket bridge not initialized"

        exec_id = f"exec_{uuid.uuid4().hex[:12]}"
        event = threading.Event()
        result_container: dict[str, Any] = {}

        with self._lock:
            self._pending[exec_id] = (event, result_container)

        log.debug("execute_code [%s]: %s", exec_id, code)
        self._send({
            "type": "execute_code",
            "executionId": exec_id,
            "code": code,
        })

        if not event.wait(timeout=self.timeout):
            with self._lock:
                self._pending.pop(exec_id, None)
            log.warning("Execution timed out [%s]", exec_id)
            return f"Execution timed out after {self.timeout} seconds"

        with self._lock:
            self._pending.pop(exec_id, None)

        resp = result_container.get("_response", {})

        if resp.get("success"):
            log.debug("execute_code [%s] succeeded: %s", exec_id, resp.get("output", "")[:200])
            return resp.get("output", "")
        log.warning("execute_code [%s] failed: %s", exec_id, resp.get("error", "Unknown error"))
        return f"Execution failed: {resp.get('error', 'Unknown error')}"

    # -- WebSocket callbacks --------------------------------------------------

    def _on_open(self, ws: Any) -> None:
        log.info("WebSocket connected")
        self._connected.set()

    def _on_error(self, ws: Any, error: Any) -> None:
        log.error("WebSocket error: %s", error)
        self._error = str(error)
        self._connected.set()

    def _on_close(self, ws: Any, close_status_code: Any, close_msg: Any) -> None:
        log.info("WebSocket closed (code=%s)", close_status_code)
        self._connected.clear()
        self._ready = False

    def _on_message(self, ws: Any, data: str) -> None:
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            return

        msg_type = msg.get("type")

        # Handle tool_call from server (bidirectional call-back)
        if msg_type == "tool_call":
            self._handle_tool_call(msg)
            return

        # Handle execution_result
        if msg_type == "execution_result":
            exec_id = msg.get("executionId")
            with self._lock:
                entry = self._pending.get(exec_id)
            if entry:
                event, container = entry
                container["_response"] = msg
                event.set()
            return

        # Handle expected response types (for _send_and_wait)
        with self._lock:
            for wait_id, (event, container) in list(self._response_events.items()):
                expected = container.get("_expect", [])
                if msg_type in expected:
                    container["_response"] = msg
                    event.set()
                    break

    def _handle_tool_call(self, msg: dict) -> None:
        """Execute a local Python function when the server calls back."""
        call_id = msg.get("callId")
        tool_name = msg.get("toolName")
        args = msg.get("args", {})

        func = self.functions.get(tool_name)
        if not func:
            log.error("No handler for tool_call: %s", tool_name)
            self._send({
                "type": "tool_result",
                "callId": call_id,
                "error": f"No handler for tool: {tool_name}",
            })
            return

        # Run in a thread to avoid blocking the WS message loop
        def _run() -> None:
            try:
                log.info("tool_call %s(%s)", tool_name, args)
                result = func(**args) if isinstance(args, dict) else func(args)
                log.debug("tool_call %s -> %s", tool_name, result)
                self._send({
                    "type": "tool_result",
                    "callId": call_id,
                    "result": result,
                })
            except Exception as e:
                log.error("tool_call %s raised: %s", tool_name, e)
                self._send({
                    "type": "tool_result",
                    "callId": call_id,
                    "error": str(e),
                })

        threading.Thread(target=_run, daemon=True).start()


# -- Public API ---------------------------------------------------------------

def create_repl_tool(
    functions: list[Callable],
    ws_url: str = "ws://localhost:9733",
    tool_name: str = "code_executor",
    timeout: int = 60,
) -> Any:
    """
    Create a LangGraph tool backed by the open-codemode WebSocket server.

    Registers the provided Python functions as bidirectional tools on the
    server. The server generates TypeScript signatures from the JSON schemas,
    which are embedded in the tool description so the LLM knows what's
    available. When executed code calls a function, the server calls back
    over the WebSocket and the function runs locally.

    Args:
        functions: Regular Python functions to expose. NOT LangGraph tools.
        ws_url:    WebSocket server URL (e.g. "ws://localhost:9733")
        tool_name: Name for the generated LangGraph tool
        timeout:   Execution timeout in seconds

    Returns:
        A LangGraph-compatible tool

    Example::

        def get_weather(location: str) -> dict:
            '''Get weather for a location'''
            return {"temp": 72, "condition": "sunny"}

        agent = create_agent(model, tools=[
            create_repl_tool([get_weather], ws_url="ws://localhost:9733")
        ])
    """
    if not functions:
        raise ValueError("At least one function must be provided")

    for func in functions:
        _validate_function(func)

    bridge = _WsBridge(ws_url, functions, timeout)
    bridge.start()

    description = (
        "Execute TypeScript/JavaScript code in a sandboxed environment.\n"
        "The code has access to the following functions:\n\n"
        f"{bridge.signatures}\n\n"
        "Use `await` for all function calls. "
        "Use `console.log()` to produce output — only logged values appear "
        "in the result. Example: `console.log(await get_temperature('NYC'))`"
    )

    @tool(tool_name)
    def execute_code(code: str) -> str:
        """Execute code with access to registered functions.

        Args:
            code: TypeScript/JavaScript code to execute
        """
        result = bridge.execute(code)
        return result

    execute_code.description = description
    return execute_code


def repl_tool(
    functions: list[Callable],
    ws_url: str = "ws://localhost:9733",
    **kwargs: Any,
) -> Any:
    """
    Shorthand for create_repl_tool.

    Args:
        functions: Python functions to expose
        ws_url:    WebSocket server URL
        **kwargs:  Forwarded to create_repl_tool
    """
    return create_repl_tool(functions, ws_url=ws_url, **kwargs)
