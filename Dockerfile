# Playwright's official image ships a real Chromium + every shared library
# it needs (libnss3, libxkbcommon, fonts, etc.) on Debian. Matches the
# playwright npm version we install on top of it — keep them in sync.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install only production deps for a small image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
