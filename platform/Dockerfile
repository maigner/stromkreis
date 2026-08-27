FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
# xz und mtools fuer den SD-Karten-Image-Bau (gateway-image.js)
RUN apk add --no-cache xz mtools
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "build"]
