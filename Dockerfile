FROM node:20-bookworm

# Install tailscale
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl iptables python3 make g++ \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list | tee /etc/apt/sources.list.d/tailscale.list >/dev/null \
  && apt-get update \
  && apt-get install -y --no-install-recommends tailscale \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /app/start.sh

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bash", "./start.sh"]
