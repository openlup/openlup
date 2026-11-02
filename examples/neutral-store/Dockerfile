FROM node:24.21.0-bookworm-slim AS application
WORKDIR /application
COPY package.json package-lock.json ./
COPY artifacts/ ./artifacts/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
USER node
EXPOSE 4319
CMD ["node", "--experimental-strip-types", "host/server.ts", "--port", "4319", "--listen", "0.0.0.0"]
