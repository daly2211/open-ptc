# LangGraph Integration with Open-CodeMode

Connects a LangGraph ReAct agent to the open-codemode **WebSocket server** for bidirectional tool calling. Your Python functions run locally; the sandbox calls them back through the WebSocket connection.

## How It Works

```
LLM  ──>  code_executor tool  ──>  WS Server  ──>  Deno sandbox
                                       │                  │
                                       │     tool_call     │
                                       │  <────────────    │
                                       │                   │
              Python func  <───────────┘                   │
              (runs locally)                               │
                    │                                      │
                    └──── tool_result ──>  WS Server ──>   │
                                                      continues
```

1. `repl_tool()` connects to the WS server, registers your functions (with auto-generated JSON Schemas), and fetches the TypeScript signatures the server produces
2. The signatures go into the tool description so the LLM knows the available API
3. When the LLM writes code that calls a function, the server sends a `tool_call` back over the WebSocket
4. The wrapper executes the Python function locally and returns the result

## Quick Start

```bash
# 1. Start the open-codemode servers
deno task start  # or docker-compose up

# 2. Install Python deps
cd examples/langgraph
pip install -r requirements.txt

# 3. Set up env
cp .env.example .env  # add OPENAI_API_KEY

# 4. Run the example
python example.py
```

## Usage

```python
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from repl_tool import repl_tool

# Define regular Python functions (NOT @tool decorated)
def get_weather(location: str) -> dict:
    """Get weather for a location.
    
    Args:
        location: City name
    """
    return {"temp": 72, "condition": "sunny"}

def calculate(a: float, b: float, operation: str) -> float:
    """Perform arithmetic.
    
    Args:
        a: First number
        b: Second number
        operation: One of add, subtract, multiply, divide
    """
    ops = {"add": a + b, "subtract": a - b}
    return ops.get(operation, 0)

# Create agent
model = init_chat_model(model="gpt-4", model_provider="openai", temperature=0)
agent = create_agent(model, tools=[
    repl_tool([get_weather, calculate], ws_url="ws://localhost:9733")
])

result = agent.invoke({"messages": [("user", "Weather in Paris?")]})
```

### Important: Use Regular Functions

The `repl_tool` expects regular Python functions, **not** LangGraph tools. If you have functions already decorated with `@tool`, you have two options:

**Option 1: Don't decorate them** (Recommended for repl_tool use)
```python
# Just define regular functions
def my_function(x: int) -> int:
    """My function"""
    return x * 2

# Use directly
code_tool = repl_tool([my_function])
```

**Option 2: Use `.__wrapped__` to access the underlying function**
```python
from langchain_core.tools import tool

@tool
def my_function(x: int) -> int:
    """My tool function"""
    return x * 2

# Access the underlying function with .__wrapped__
code_tool = repl_tool([my_function.__wrapped__])

# You can also use my_function as a standalone LangGraph tool
agent = create_agent(model, tools=[my_function, code_tool])
```

The second option is useful if you want to use the same functions both as standalone LangGraph tools AND within the code execution environment.

### Configuration

```python
code_tool = repl_tool(
    functions=[func1, func2],
    ws_url="ws://custom-host:9733",  # WebSocket server URL
    tool_name="my_executor",         # Custom tool name
    timeout=120,                     # Execution timeout (seconds)
)
```

## JSON Schema Generation

The wrapper auto-generates JSON Schemas from your Python type hints and docstrings. These schemas are sent to the WS server during registration, and the server uses its own signature generator to produce TypeScript declarations.

```python
def search(query: str, max_results: int = 10) -> list:
    """Search for items.
    
    Args:
        query: Search query string
        max_results: Maximum number of results to return
    """
    ...
```

Generates this schema:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Search query string" },
    "max_results": { "type": "integer", "description": "Maximum number of results to return", "default": 10 }
  },
  "required": ["query"]
}
```

Which the server turns into a TypeScript signature in the tool description.

## Best Practices

1. **Use type hints** - they drive the JSON Schema generation
2. **Write docstrings with Args sections** - parameter descriptions end up in the schema
3. **Keep functions simple** - single purpose, JSON-serializable inputs/outputs
4. **Handle errors in your functions** - exceptions are caught and sent back as `tool_result` errors

## Files

| File | Purpose |
|------|---------|
| `repl_tool.py` | Core wrapper: validation, schema gen, WS bridge, LangGraph tool |
| `example.py` | Working example with temperature + math functions |
| `requirements.txt` | Python dependencies |
