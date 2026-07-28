# resume-website

Dackota Johnson's interactive resume, served at **[me.dackota.com](https://me.dackota.com)** —
the resume presented as a platform console: a `kubectl` hero, a Kargo-style career
promotion pipeline, an animated metrics board, an interactive terminal you can
actually type into, skills as cluster namespaces, and a career changelog cut with
conventional commits.

Pure static HTML/CSS/JS (no build step, no frameworks, no external assets — the
nginx CSP is `default-src 'self'`), served by unprivileged nginx on 8080.

## How it ships

The site is its own demo — it deploys through the same GitOps pipeline the resume
describes:

```
git push → GitHub Actions (Grype-scanned, multi-arch) → release-please tag
        → ghcr.io/dackota/resume-website → Renovate PR in the gitops repo
        → ArgoCD → generic-app-chart → free-tier OKE (Ampere A1)
        → Traefik Gateway + cert-manager TLS
```

- **CI** (`ci.yml`): builds the image and smoke-tests it (`/healthz`, page content,
  SPA fallback) on every PR and push to main. No push to the registry.
- **Releases** (`release-please.yml`): conventional commits on main open/merge a
  release PR; the resulting `v*` tag triggers `publish.yml`.
- **Publish** (`publish.yml`): Grype-scans (fails on HIGH/CRITICAL before any
  push), then builds and pushes amd64+arm64 to ghcr.
- **Renovate** (`renovate.yml`): keeps the digest-pinned nginx base and SHA-pinned
  actions current; base-image bumps commit as `fix:` so they cut a release.

Deployment lives in
[free-tier-oracle-cloud-k8s](https://github.com/dackota/free-tier-oracle-cloud-k8s)
under `gitops/workloads/resume-website/`, as a thin dependency on
[generic-app-chart](https://github.com/dackota/generic-app-chart).

## Local dev

```
docker build -t resume-website:dev .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp resume-website:dev
```

…or just open `index.html` in a browser.
