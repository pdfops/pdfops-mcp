# pdfops-mcp — stdio MCP server, containerised for Docker's MCP registry / Toolkit.
# Inside a container the agent's file paths do not exist, so pass PDF sources as
# https:// URLs or data:application/pdf;base64 URIs and omit output_path to get
# the result back inline (see README "Running remotely").
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json README.md LICENSE ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
