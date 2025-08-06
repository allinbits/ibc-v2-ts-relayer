# syntax=docker/dockerfile:1

FROM node:20-alpine 

# Use production node environment by default.
# ENV NODE_ENV production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /usr/src/app

# Copy the rest of the source files into the image.
COPY . .
RUN rm -rf node_modules

# Download dependencies as a separate step to take advantage of Docker's caching.
# Leverage a cache mount to /root/.npm to speed up subsequent builds.
# Leverage a bind mounts to package.json and package-lock.json to avoid having to copy them into
# into this layer.
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,id=pnpm,target=/pnpm/store \
    npm install -g pnpm typescript && \
    pnpm install && \
    pnpm build

RUN chmod +x ./scripts/ibc-v2-ts-relayer
ENV PATH="/usr/src/app/scripts:$PATH"
ENTRYPOINT ["ibc-v2-ts-relayer"]
CMD        [ "relay" ]