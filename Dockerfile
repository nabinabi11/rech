# RECH server. The image also carries the rech package itself, served at /rech.tgz,
# so people install the CLI straight from their own network.
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY README.md ./
# npm pack runs the build (the prepare script) and produces the tarball the server hands out
RUN npm ci --ignore-scripts && mkdir /out && npm pack --pack-destination /out

FROM node:24-slim
COPY --from=build /out/rech-*.tgz /opt/rech/rech.tgz
RUN npm install -g /opt/rech/rech.tgz && npm cache clean --force
ENV RECH_DATA=/data \
    RECH_PACKAGE=/opt/rech/rech.tgz \
    RECH_PORT=7777
VOLUME /data
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:7777/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["rech", "up"]
