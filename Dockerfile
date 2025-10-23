FROM node:20-bullseye

# Chrome と依存
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y \
    google-chrome-stable \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 libdrm2 libxcb1 \
    python3 python3-pip \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# STDIO⇔SSE/HTTP ブリッジ
RUN pip3 install --no-cache-dir mcp-proxy

# DevTools MCP 本体を事前インストール（起動高速化）
RUN npm i -g chrome-devtools-mcp@latest

WORKDIR /app
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

ENV PORT=8080
EXPOSE 8080
CMD ["/app/start.sh"]
