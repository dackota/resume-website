# check=skip=SecretsUsedInArgOrEnv

# The check above is skipped for one reason: HONEYCOMB_API_KEY is declared as
# an empty ENV near the bottom of this file so the config template renders
# deterministically. No secret is baked in — the real key arrives at run time
# from a Secret. Without the skip every build prints a warning that is wrong
# here, which is a good way to teach everyone to ignore build warnings.
#
# Static single-page site served by unprivileged nginx on 8080 (non-root,
# works with readOnlyRootFilesystem + a writable /tmp — see nginx.conf.template).
# Base image digest-pinned per the supply-chain convention shared with
# consulting-spa and change-tracking-dashboard; bump tag+digest together.
FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:a6c3ec0c0d249d68b0682df854d4a9e222b90fb607dc3fcf2f1d2fcbc85d347e

# Build steps run as root because both of them write outside the runtime
# user's reach: apk needs the package db, and the version substitution below
# rewrites a root-owned file in a root-owned directory (sed -i writes a temp
# file alongside its target, so directory write permission is required).
# The image drops back to the unprivileged uid at the end, before EXPOSE.
USER root

# The /api/changes/ and /v1/traces proxies speak TLS to upstreams with
# proxy_ssl_verify on, which needs a trust store present at a known path.
# Installed explicitly rather than inherited, so a base-image change can't
# silently break it.
RUN apk add --no-cache ca-certificates && \
    test -s /etc/ssl/certs/ca-certificates.crt

# The config is a template rather than a finished file so the Honeycomb ingest
# key can be supplied at run time (a Secret in the gitops repo) instead of being
# baked into a published image. The base image's entrypoint renders every
# *.template in NGINX_ENVSUBST_TEMPLATE_DIR into NGINX_ENVSUBST_OUTPUT_DIR
# before starting nginx; that output has to land in /tmp, because /tmp is the
# only writable path under the chart's readOnlyRootFilesystem. Hence the
# explicit `-c /tmp/nginx.conf` in CMD — the default would read the image's
# own /etc/nginx/nginx.conf and none of this would apply.
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
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

# HONEYCOMB_API_KEY is declared empty on purpose rather than left unset: the
# entrypoint builds its substitution list from variables that *exist*, so an
# unset name would be left as a literal `${HONEYCOMB_API_KEY}` in the rendered
# config and become a bogus auth header. Empty makes the /v1/traces block take
# its no-key branch (204) instead. The filter keeps envsubst away from nginx's
# own $uri/$args/$http_accept, which are not env vars and must survive verbatim.
ENV NGINX_ENVSUBST_TEMPLATE_DIR=/etc/nginx/templates \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
    NGINX_ENVSUBST_FILTER="^HONEYCOMB_" \
    HONEYCOMB_API_KEY=""

EXPOSE 8080

CMD ["nginx", "-c", "/tmp/nginx.conf", "-g", "daemon off;"]
