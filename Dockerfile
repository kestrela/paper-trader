FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY *.js ./
COPY README_CN.md ./
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "app.js"]
