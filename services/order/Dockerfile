FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrations ./migrations
EXPOSE 3006
CMD ["npm", "start"]
