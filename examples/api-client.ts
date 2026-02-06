import "@std/dotenv/load";

// Example API client for testing the HTTP server endpoints

const API_BASE = Deno.env.get("API_BASE_URL") || "http://localhost:9730";

async function getTree(includeDescriptions: boolean, charLimit?: number) {
  console.log("\n=== Test: Get Tools Tree ===");
  let url = `${API_BASE}/tree?descriptions=${includeDescriptions}`;
  if (charLimit !== undefined) {
    url += `&charLimit=${charLimit}`;
  }
  const response = await fetch(url);
  const data = await response.text();
  console.log("Status:", response.status);
  console.log("Tree:", data);
}

async function testGetAllSignatures() {
  console.log("\n=== Test: Get All Signatures ===");
  const response = await fetch(`${API_BASE}/signatures`);
  const data = await response.text();
  console.log("Status:", response.status);
  console.log("Signatures:", data);
}

async function testGetSignaturesByServer() {
  console.log("\n=== Test: Get Signatures by Server ===");
  const response = await fetch(`${API_BASE}/signatures?serverNames=tavily_mcp`);
  const data = await response.text();
  console.log("Status:", response.status);
  console.log("Signatures:", data);
}

async function testGetSignaturesByToolName() {
  console.log("\n=== Test: Get Signatures by Tool Name ===");
  const response = await fetch(`${API_BASE}/signatures?toolNames=tavily_mcp.tavily_search`);
  const data = await response.text();
  console.log("Status:", response.status);
  console.log("Signatures:", data);
}

async function testGetSignaturesCombined() {
  console.log("\n=== Test: Get Signatures Combined (Server + Tool) ===");
  const response = await fetch(
    `${API_BASE}/signatures?serverNames=tavily_mcp&toolNames=tavily_mcp.tavily_extract`
  );
  const data = await response.text();
  console.log("Status:", response.status);
  console.log("Signatures:", data);
}

async function testExecuteCode() {
  console.log("\n=== Test: Execute Code ===");
  const code = `
const result = await tavily_mcp.tavily_search({
  query: 'What is Deno?',
  max_results: 2
});
console.log(JSON.stringify(result.results[0].title));
`;

  const response = await fetch(`${API_BASE}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Result:", data);
}

async function testExecuteCodeOneMinute() {
  console.log("\n=== Test: Execute Code (1 Minute) ===");
  const code = `
const start = Date.now();
await new Promise((resolve) => setTimeout(resolve, 60_000));
console.log(\`Waited \${Math.round((Date.now() - start) / 1000)} seconds\`);
`;

  const response = await fetch(`${API_BASE}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Result:", data);
}

async function testExecuteCodeError() {
  console.log("\n=== Test: Execute Code with Error ===");
  const code = `
// This will cause an error
const result = await nonexistent_server.fake_tool({ foo: "bar" });
`;

  const response = await fetch(`${API_BASE}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Result:", data);
}

async function testMissingCode() {
  console.log("\n=== Test: Missing Code Field ===");
  const response = await fetch(`${API_BASE}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Error:", data);
}

async function testNotFound() {
  console.log("\n=== Test: 404 Not Found ===");
  const response = await fetch(`${API_BASE}/nonexistent`);
  const data = await response.json();
  console.log("Status:", response.status);
  console.log("Error:", data);
}

// Run all tests
async function runTests() {
  console.log("Starting API tests...");
  console.log("Make sure httpServer.ts is running on port 9730");

  try {
    await getTree(false);
    await getTree(true, 100);
    await testGetAllSignatures();
    await testGetSignaturesByServer();
    await testGetSignaturesByToolName();
    await testGetSignaturesCombined();
    await testExecuteCode();
    await testExecuteCodeOneMinute();
    await testExecuteCodeError();
    await testMissingCode();
    await testNotFound();

    console.log("\n=== All tests completed ===");
  } catch (error) {
    console.error("\nTest failed:", error);
    console.error("Make sure the server is running: deno run --allow-net --allow-read --allow-env httpServer.ts");
  }
}

if (import.meta.main) {
  runTests();
}
