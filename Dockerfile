# BypassX Deobf Bot — production image (Render free tier / any Docker host)
#
# Static-analysis only: the bot never executes user samples. The deobf engine
# is fetched from the repo's GitHub release at build time and verified.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Engine: download precompiled binary (glibc 2.31+, ~147 MB unpacked) from the
# release, verify it runs, and point ENGINE_PATH at it (skips boot-time fetch).
RUN curl -fsSL "https://github.com/LegendXD221/BypassX-Deobf-Bot/releases/latest/download/bypassx-deobf.gz" -o /tmp/engine.gz \
    && gunzip -c /tmp/engine.gz > /app/bin/bypassx-deobf \
    && rm /tmp/engine.gz \
    && chmod 0755 /app/bin/bypassx-deobf \
    && /app/bin/bypassx-deobf --version

ENV ENGINE_PATH=/app/bin/bypassx-deobf

EXPOSE 3000
CMD ["node", "src/index.js"]
