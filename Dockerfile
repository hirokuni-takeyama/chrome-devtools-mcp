FROM node:20-bookworm

# Chrome と依存
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y \
    google-chrome-stable \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 libdrm2 libxcb1 \
    python3 python3-venv python3-pip \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ---- PEP668対策：仮想環境に mcp-proxy を入れる ----
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir mcp-proxy
ENV PATH="/opt/venv/bin:${PATH}"

# DevTools MCP 本体（起動高速化のため事前インストール）
RUN npm i -g chrome-devtools-mcp@latest

WORKDIR /app
COPY package*.json /app/
RUN npm ci --omit=dev && npm cache clean --force
COPY server-gateway.js /app/server-gateway.js
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server-gateway.js"]
