# Use official Deno image
FROM denoland/deno:latest

# Set working directory
WORKDIR /app

# Copy dependency files first for better caching
COPY deno.json .

# Copy application files
COPY *.ts .
COPY mcp_config.json .

# Cache dependencies
RUN deno cache api-server.ts mcp-server.ts

# Create a startup script to run both servers
RUN echo '#!/bin/sh\n\
deno run --allow-all api-server.ts &\n\
API_PID=$!\n\
deno run --allow-all mcp-server.ts &\n\
MCP_PID=$!\n\
echo "Started API Server (PID: $API_PID) and MCP Server (PID: $MCP_PID)"\n\
wait $API_PID $MCP_PID' > /app/start.sh && chmod +x /app/start.sh

# Expose ports
EXPOSE 9730 9731

# Start both servers
CMD ["/app/start.sh"]
