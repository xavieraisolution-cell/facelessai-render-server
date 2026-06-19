FROM node:20-slim

# Force rebuild: 2026-05-28
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
FROM node:20-slim
# Force rebuild: 2026-05-28
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY render_montage.js .
EXPOSE 3000
CMD ["node", "server.js"]
