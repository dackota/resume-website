# Static single-page site served by unprivileged nginx on 8080 (non-root,
# works with readOnlyRootFilesystem + a writable /tmp — see nginx.conf).
# Base image digest-pinned per the supply-chain convention shared with
# consulting-spa and change-tracking-dashboard; bump tag+digest together.
FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:59ccf0943b0b8e8d9e6ea9039a39555730f544701a655c596f7df7d096c593f5

# Build steps run as root because both of them write outside the runtime
# user's reach: apk needs the package db, and the version substitution below
# rewrites a root-owned file in a root-owned directory (sed -i writes a temp
# file alongside its target, so directory write permission is required).
# The image drops back to the unprivileged uid at the end, before EXPOSE.
USER root

# The /api/changes/ proxy speaks TLS to an upstream with proxy_ssl_verify on,
# which needs a trust store present at a known path. Installed explicitly
# rather than inherited, so a base-image change can't silently break it.
RUN apk add --no-cache ca-certificates && \
    test -s /etc/ssl/certs/ca-certificates.crt

COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html favicon.svg /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

# Asset URLs carry the release version. The filenames aren't content-hashed
# (no build step), and index.html is served no-cache while /assets/ is cached
# for a week — so without this, a returning visitor gets new HTML against a
# stale app.js until their cache expires. release-please writes the version
# into the manifest in the same commit that cuts the release, so reading it
# here needs no CI wiring. If the substitution ever fails the literal
# placeholder survives in the URL, which still resolves — the query string is
# not part of $uri, so try_files serves the file either way.
COPY .release-please-manifest.json /tmp/manifest.json
RUN ASSET_VER="$(sed -n 's/.*"\.": *"\([^"]*\)".*/\1/p' /tmp/manifest.json)" && \
    test -n "$ASSET_VER" && \
    sed -i "s|__ASSET_VER__|${ASSET_VER}|g" /usr/share/nginx/html/index.html && \
    ! grep -q "__ASSET_VER__" /usr/share/nginx/html/index.html && \
    rm /tmp/manifest.json

USER 101

EXPOSE 8080
