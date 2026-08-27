# check=skip=SecretsUsedInArgOrEnv

# The check above is skipped for one reason: HONEYCOMB_API_KEY is declared as
# an empty ENV near the bottom of this file so the config template renders
# deterministically. No secret is baked in — the real key arrives at run time
# from a Secret. Without the skip every build prints a warning that is wrong
# here, which is a good way to teach everyone to ignore build warnings.
# (It has to be the first line in the file: BuildKit only reads parser
# directives before any comment or instruction.)

# ============================ blog build stage ============================
# Hugo renders blog/content into static HTML here, so the runtime image stays
# pure static files and the CSP never has to accommodate a client-side renderer.
# Hugo owns /blog/ only — index.html is hand-written and never templated.
#
# The builder reuses the runtime base image rather than introducing a second
# one: it is already digest-pinned, already pulled, and already known to Grype
# and Renovate. A separate alpine would be one more digest to keep current for
# no benefit.
#
# --platform=$BUILDPLATFORM pins this stage to the machine doing the building.
# publish.yml builds amd64+arm64, and generated HTML is identical either way, so
# running Hugo twice — once under emulation — would cost minutes to produce
# byte-identical output.
FROM --platform=$BUILDPLATFORM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:a6c3ec0c0d249d68b0682df854d4a9e222b90fb607dc3fcf2f1d2fcbc85d347e AS blog

USER root

# Hugo comes from gohugoio's own release artifact with a pinned checksum, not
# from a third-party repackaged image — same reasoning as installing
# ca-certificates explicitly below rather than inheriting it. Renovate keeps the
# version and checksums current via the custom manager in renovate.json; the
# regex there matches these three lines, so keep their shape if you edit them.
#
# Non-extended build on purpose: the extended variant only adds Sass, and blog
# CSS is plain and lives in /assets/ with the rest of the site's stylesheets.
ARG HUGO_VERSION=0.164.0
ARG HUGO_SHA256_AMD64=d9c8b17285ea4ec004d9f814273ea910f2051ce02c284993fd1f91ba455ae50d
ARG HUGO_SHA256_ARM64=948ee5f0ed30175f31937d592d63a2712f0761a69f1cbe812f780eb918a08b8e
ARG BUILDARCH

RUN apk add --no-cache curl tar ca-certificates && \
    case "$BUILDARCH" in \
      amd64) HUGO_SHA256="$HUGO_SHA256_AMD64" ;; \
      arm64) HUGO_SHA256="$HUGO_SHA256_ARM64" ;; \
      *) echo "no pinned Hugo checksum for build arch '$BUILDARCH'" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/hugo.tar.gz \
      "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-${BUILDARCH}.tar.gz" && \
    echo "${HUGO_SHA256}  /tmp/hugo.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo && \
    rm /tmp/hugo.tar.gz && \
    hugo version

WORKDIR /src

# Config and templates first, content last: editing a post then invalidates one
# small layer instead of re-downloading Hugo. There is no local Hugo install by
# design (the pinned tarball is the only one that ever runs), so `docker build`
# is the authoring preview loop and its speed is the writing experience.
COPY blog/hugo.toml ./
COPY blog/layouts ./layouts
COPY blog/archetypes ./archetypes
COPY blog/content ./content

# Drafts are excluded (Hugo's default), so `draft = true` merged to main simply
# does not appear. --gc drops stale cache entries; --minify shrinks output that
# nginx then also gzips.
RUN hugo --destination /out --minify --gc && \
    test -s /out/index.html && \
    test -s /out/index.xml

# ============================== runtime image ==============================
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
#
# libssl3/libcrypto3 are upgraded explicitly because the pinned base image
# still ships 3.5.7-r0 (CVE-2026-18798 and others, fixed in 3.5.8-r0), even at
# its latest digest for this tag. Grype fails the build on it otherwise.
# Drop this once a base-image bump carries the fix.
RUN apk add --no-cache ca-certificates && \
    apk upgrade --no-cache libssl3 libcrypto3 && \
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
COPY --from=blog /out/ /usr/share/nginx/html/blog/

# Asset URLs carry the release version. The filenames aren't content-hashed
# (no build step), and index.html is served no-cache while /assets/ is cached
# for a week — so without this, a returning visitor gets new HTML against a
# stale app.js until their cache expires. release-please writes the version
# into the manifest in the same commit that cuts the release, so reading it
# here needs no CI wiring. If the substitution ever fails the literal
# placeholder survives in the URL, which still resolves — the query string is
# not part of $uri, so try_files serves the file either way.
#
# The pass covers every .html in the image, not just index.html: Hugo's pages
# link the same /assets/styles.css and would otherwise pin week-stale CSS. The
# guard is correspondingly stricter — no file anywhere may still contain the
# placeholder — so an HTML file that legitimately should not be stamped fails
# the build. That is the intended default.
COPY .release-please-manifest.json /tmp/manifest.json
RUN ASSET_VER="$(sed -n 's/.*"\.": *"\([^"]*\)".*/\1/p' /tmp/manifest.json)" && \
    test -n "$ASSET_VER" && \
    find /usr/share/nginx/html -name '*.html' -exec \
      sed -i "s|__ASSET_VER__|${ASSET_VER}|g" {} + && \
    ! grep -rq "__ASSET_VER__" /usr/share/nginx/html && \
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
