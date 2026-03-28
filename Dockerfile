# Use a lightweight, secure Node.js Alpine image
FROM node:20-alpine

# Set the working directory
WORKDIR /usr/src

# Set environment to production
ENV NODE_ENV=production

# Copy package files and install dependencies
# We use ci (clean install) for predictable builds
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
# COPY . .
#COPY worker/ src/
#COPY supabase/ src/

#COPY ./x/a.txt ./y/a.txt /no_parents/
#COPY --parents ./x/a.txt ./y/a.txt /parents/

# /no_parents/a.txt
# /parents/x/a.txt
# /parents/y/a.txt


COPY --exclude=./certificates/ . .



# IMPORTANT: The current server.js imports a .ts file directly:
# import { fetchDailySeed } from './src/workers/daily-vrf-seed.ts';
# Since Node natively struggles with TS imports without flags, 
# we'll use tsx which is already in your dependencies to run it.
# Alternatively, you can pre-compile the TS to JS.

# Create a non-root user for security (Standard security practice for crypto apps)
RUN addgroup -S aegisgroup && adduser -S aegisuser -G aegisgroup
RUN chown -R aegisuser:aegisgroup /usr/src
# COPY --from=builder --chown=aegisuser:aegisgroup /usr/src/app/apps/casino-web/.next/standalone ./

USER aegisuser

# Expose the WebSocket port
EXPOSE 3001

# Start the server using tsx to support the TypeScript worker import
CMD ["node", "server.js"]

