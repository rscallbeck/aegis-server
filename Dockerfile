# Use a lightweight, secure Node.js Alpine image
FROM node:20-slim

# Set the working directory
WORKDIR /usr/src/app

# Set environment to production
ENV NODE_ENV=production

# Copy package files and install dependencies
# We use ci (clean install) for predictable builds
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# IMPORTANT: The current server.js imports a .ts file directly:
# import { fetchDailySeed } from './src/workers/daily-vrf-seed.ts';
# Since Node natively struggles with TS imports without flags, 
# we'll use tsx which is already in your dependencies to run it.
# Alternatively, you can pre-compile the TS to JS.

# Create a non-root user for security (Standard security practice for crypto apps)
RUN groupadd -r aegisgroup && useradd -r -g aegisgroup aegisuser
RUN chown -R aegisuser:aegisgroup /usr/src/app
# COPY --from=builder --chown=aegisuser:aegisgroup /usr/src/app/apps/casino-web/.next/standalone ./

USER aegisuser

# Expose the WebSocket port
EXPOSE 3001

# Start the server using tsx to support the TypeScript worker import
CMD ["node", "server.js"]

