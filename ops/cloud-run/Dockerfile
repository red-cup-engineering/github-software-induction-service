# syntax=docker/dockerfile:1.7
FROM node:22.18-bookworm-slim

COPY --chown=node:node lib /app/lib
WORKDIR /app/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-services-section/services/web-services-section/services/web-platform-services-section/services/web2-platform-services-section/services/web2-software-platform-services-section/services/github-services-section/services/github-software-induction-service
USER root
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@11 \
    && test -f package-lock.json \
    && npm ci --install-links --omit=dev --no-audit --no-fund && npm cache clean --force \
    && npm run check && npm test

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 \
    AGENT_CARD_SIGNING_KEY=/secrets/a2a-key/signing-key.pem \
    AGENT_CARD_JWKS=/secrets/a2a-jwks/jwks.json \
    AGENT_CARD_SIGNING_KID=github-software-induction-service-ed25519 \
    AGENT_CARD_SIGNING_ALG=EdDSA
USER node
EXPOSE 8080
CMD ["node", "src/serve-activitypub.mjs"]
