const RPC_SERVER_URL = Deno.env.get("RPC_SERVER_URL") || 'http://localhost:9732'

export async function callTool(
  toolRef: string,
  args?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(RPC_SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'callTool',
      params: { toolRef, args },
    }),
  })

  const { error, result } = await response.json()

  if (error) throw new Error(`JSON-RPC Error: ${error.message}`)
  if (!result.success) throw new TypeError(result.error || `Tool call failed for ${toolRef}`)

  return result.data
}
