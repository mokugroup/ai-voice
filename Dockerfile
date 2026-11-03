FROM node:22-slim

WORKDIR /app

# Install the production LiveKit agent dependencies from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY agent.mjs ./

# The worker connects outbound to LiveKit, so no port needs exposing.
CMD ["node", "agent.mjs", "start"]
