+++
title = "Why this site has a blog now"
date = 2026-08-04
summary = "A placeholder first post — and the load-bearing fixture the CI smoke test asserts against."
tags = ["meta", "platform-engineering"]
draft = false
+++

This is a placeholder. It exists so there is something real at a real URL while
the rest of the blog gets built out, and it is deliberately the post that CI
asserts against — the smoke test fetches this page on every pull request to
prove Hugo actually ran and its output landed where nginx expects it.

That makes this post load-bearing. Deleting it breaks the build until the
assertion in `.github/workflows/ci.yml` is pointed somewhere else, which is a
reasonable trade: a blog should not be deleting its oldest permalink anyway.

## What this thing is

The blog ships inside the same container image as the resume, through the same
pipeline the resume describes: conventional commits cut a release, the release
tag builds and pushes a multi-arch image, Renovate opens a PR in the GitOps
repo, and ArgoCD rolls it out. Publishing a post and shipping a base-image
security patch are the same operation.

That is a slightly absurd amount of machinery for some prose. It is also the
point — the site argues that the delivery pipeline should be legible, and the
cheapest way to make that argument honestly is to run the argument in public.

## What to expect here

Notes on the parts of platform engineering that do not photograph well:
promotion pipelines that survive a bad Tuesday, multi-tenant isolation that
holds when a tenant misbehaves, and the specific ways Kubernetes clusters go
wrong at three in the morning.

Replace this post whenever there is something real to say.
