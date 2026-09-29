# The test stage runs on every build: a failing test stops the deployment.
FROM node:24-alpine AS test
WORKDIR /app
COPY . .
RUN node --test "test/*.test.js"

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=test /app/package.json /app/server.js ./
COPY --from=test /app/lib ./lib
COPY --from=test /app/scripts ./scripts
COPY --from=test /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
