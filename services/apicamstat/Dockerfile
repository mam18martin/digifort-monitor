FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/services/apicamstat
COPY services/apicamstat/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY services/apicamstat/index.js services/apicamstat/*.cjs ./
COPY packages/security /app/packages/security
USER node
EXPOSE 3001
CMD ["node","index.js"]
