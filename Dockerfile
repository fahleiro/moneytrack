# Imagem do painel web (Node). O banco roda como imagem pública à parte (postgres).
FROM node:20-alpine

WORKDIR /app

# Instala só as deps de produção (cacheável)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App + schema/seed (o server.js carrega o seed na subida se a base estiver vazia)
COPY web ./web
COPY db ./db

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "web/server.js"]
