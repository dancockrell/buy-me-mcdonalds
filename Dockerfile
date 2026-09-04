FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep
ENV NODE_ENV=production PORT=8787 PUBLIC_BASE_URL=http://localhost:8787 PAYPAL_ME_HANDLE=Morasoom
EXPOSE 8787
USER node
CMD ["node", "src/server.mjs"]
