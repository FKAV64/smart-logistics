FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY tomtom-mock.js .

EXPOSE 7777

CMD ["node", "tomtom-mock.js"]
