FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

# Default command, overridden in docker-compose.yml for the worker
CMD ["npm", "start"]
