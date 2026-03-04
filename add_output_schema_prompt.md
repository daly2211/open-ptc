You are given an MCP server config JSON.
Task:

Discover all available tools.
For each discovered tool, call it in READ-ONLY ways (safe sample inputs, no mutations). If the tool is write-only, skip it and do not include it in the output.
Inspect returned outputs and infer a practical JSON Schema for each tool output.
Return the same config JSON, adding a tools array where each tool includes:
name
output_schema (JSON Schema Draft-style object)
Preserve existing fields exactly and do not remove transport settings.
If uncertain about a field type, use a permissive schema and describe assumptions in field descriptions.
Input config:
[
  {
    "name": "tavily",
    "transport": {
      "type": "http",
      "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
    }
  }
]


Output format:
Return only valid JSON for the updated config array.