# syntax=docker/dockerfile:1

FROM node:current-alpine3.22

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
RUN apk add gnome-keyring
RUN apk add dbus
RUN apk add bash
RUN apk add libcap
RUN apk add --no-cache sudo
RUN cp ./scripts/with_keyring /etc/with_keyring
RUN cp ./scripts/keyring_session /etc/keyring_session
RUN chmod +x /etc/with_keyring
RUN chmod +x /etc/keyring_session
ENV PATH="/usr/src/app/scripts:$PATH"
ENTRYPOINT ["/etc/with_keyring"]
CMD        [ "ibc-v2-ts-relayer", "relay" ]