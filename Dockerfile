FROM node:22-alpine

WORKDIR /app

# المشروع بلا أي اعتمادية خارجية — غير الكود
COPY package.json ./
COPY server.mjs direct.mjs ./
COPY public ./public

# منصات الاستضافة كتعطي PORT؛ الخادم كيقراه أوتوماتيكيًا
ENV NODE_ENV=production
ENV WORKSPACE=/app
EXPOSE 8790

CMD ["node", "server.mjs"]
