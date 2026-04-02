# Build stage
FROM node:20-alpine AS build

WORKDIR /app

# Install root deps (backend)
COPY package*.json ./
RUN npm install

# Install and build frontend
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy the rest of the source
COPY . .

# Build frontend
RUN cd client && npm run build

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Copy only what we need for runtime
COPY package*.json ./
RUN npm install --only=production

COPY server.js ./server.js

# Copy built frontend
COPY --from=build /app/client/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "http=require('http');http.get('http://localhost:4000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]