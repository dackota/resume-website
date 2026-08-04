# resume-website

Dackota Johnson's interactive resume, served at **[me.dackota.com](https://me.dackota.com)** —
the resume presented as a platform console: a `kubectl` hero, a Kargo-style career
promotion pipeline, an animated metrics board, an interactive terminal you can
actually type into, and a career changelog cut with conventional commits.

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

## Blog

Posts live at [me.dackota.com/blog](https://me.dackota.com/blog/), built by Hugo
in a builder stage at image build. Hugo owns `blog/` and nothing else — the
resume page stays hand-written HTML and is never templated, so a Hugo upgrade
can't regress it.

**Writing a post** — copy the archetype bundle, write markdown, commit:

```
cp -r blog/archetypes/post blog/content/posts/my-post
```

The directory name is the URL (`/blog/my-post/`). Fill in the frontmatter
(`title`, `date`, `summary`, `tags`), set `draft = false`, and commit it as
`feat(blog): …` — a non-releasing commit type would merge to main and never
ship, since `publish.yml` only runs on `v*` tags. Images go inside the post
directory and are referenced by bare filename.

Notes:

- **There is no local Hugo install by design.** The checksum-pinned tarball in
  the builder stage is the only Hugo that ever runs, so local output can't drift
  from CI. The preview loop is the `docker build` below; content is copied last
  in the builder stage so a prose edit rebuilds in seconds.
- Renovate tracks Hugo releases, but **cannot compute the tarball checksums** —
  its PRs need `HUGO_SHA256_AMD64` / `HUGO_SHA256_ARM64` updated by hand, and
  the build fails on `sha256sum -c` until they are.
- Syntax highlighting emits CSS classes, not inline styles (`noClasses = false`),
  because the CSP is `style-src 'self'`. The token colours live in
  `assets/blog.css`.
- `blog/content/posts/hello-world/` is a **load-bearing CI fixture** — the smoke
  test asserts against it. Deleting it means updating `ci.yml`.
- `/assets/og.png` (1200×630) is referenced as the link-preview image for every
  post. Until that file exists, shares render a text-only card.

## Local dev

```
docker build -t resume-website:dev .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp resume-website:dev
```

…or just open `index.html` in a browser — though that covers the resume page
only. The blog needs the image build, since Hugo runs there.
