FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=America/Sao_Paulo
RUN apk add --no-cache tzdata
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
