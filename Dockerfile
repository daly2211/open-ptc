# Use official Deno image
FROM denoland/deno:latest

WORKDIR /app

# Copy dependency files first for better caching
COPY deno.json .

# Copy application files
COPY src/ src/
COPY mcp_config.json .

# Cache dependencies
RUN deno cache src/server.ts

# Expose ports (RPC 9732 is internal-only, not exposed)
EXPOSE 9730 9731 9733 9734

# Start unified server (runs all services by default)
CMD ["run", "--allow-all", "src/server.ts"]
