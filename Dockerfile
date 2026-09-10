# ffmpeg уже собран в этом образе — не тянем его через apt
FROM jrottenberg/ffmpeg:6.1-ubuntu

# ставим Node.js 18
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates fonts-dejavu-core \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# на всякий случай сбрасываем ENTRYPOINT базового образа (он указывает на ffmpeg)
ENTRYPOINT []

EXPOSE 3000
CMD ["node", "server.js"]
