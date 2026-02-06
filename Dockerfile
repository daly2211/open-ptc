# Use official Deno image
FROM denoland/deno:latest

# Set working directory
WORKDIR /app

# Copy dependency files first for better caching
COPY deno.json .

# Copy application files
COPY src/ src/
COPY mcp_config.json .

# Cache dependencies
RUN deno cache src/servers/api-server.ts src/servers/mcp-server.ts src/servers/ws-server.ts

# Create a startup script to run all servers
RUN echo '#!/bin/sh\n\
deno run --allow-all src/servers/api-server.ts &\n\
API_PID=$!\n\
deno run --allow-all src/servers/mcp-server.ts &\n\
MCP_PID=$!\n\
deno run --allow-all src/servers/ws-server.ts &\n\
WS_PID=$!\n\
echo "Started API Server (PID: $API_PID), MCP Server (PID: $MCP_PID), WS Server (PID: $WS_PID)"\n\
wait $API_PID $MCP_PID $WS_PID' > /app/start.sh && chmod +x /app/start.sh

# Expose ports
EXPOSE 9730 9731 9733

# Start all servers
CMD ["/app/start.sh"]
