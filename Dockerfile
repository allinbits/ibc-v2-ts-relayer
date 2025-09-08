# syntax=docker/dockerfile:1.10

FROM node:current-alpine3.22

# Use production node environment by default.
# ENV NODE_ENV production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /usr/src/app

RUN apk add --no-cache \
    curl \
    bash \
    gnome-keyring \
    dbus \
    libcap \
    sudo


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

COPY docker/relayer/bin /bin

ENV PATH="/bin:/usr/src/app/scripts:$PATH"

ENTRYPOINT ["/bin/with_keyring"]
CMD        [ "ibc-v2-ts-relayer", "relay" ]