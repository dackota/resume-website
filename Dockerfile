# Static single-page site served by unprivileged nginx on 8080 (non-root,
# works with readOnlyRootFilesystem + a writable /tmp — see nginx.conf).
# Base image digest-pinned per the supply-chain convention shared with
# consulting-spa and change-tracking-dashboard; bump tag+digest together.
FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24@sha256:59ccf0943b0b8e8d9e6ea9039a39555730f544701a655c596f7df7d096c593f5

# The /api/changes/ proxy speaks TLS to an upstream with proxy_ssl_verify on,
# which needs a trust store present at a known path. Installed explicitly
# rather than inherited, so a base-image change can't silently break it.
USER root
RUN apk add --no-cache ca-certificates && \
    test -s /etc/ssl/certs/ca-certificates.crt
USER 101

COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html favicon.svg /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
