+++
title = "Post title"
date = 1970-01-01
summary = "One sentence. This drives the list page and the link-preview card, so write it like a subtitle rather than a teaser."
tags = ["kubernetes"]
draft = true
+++

Copy this whole directory to start a post:

    blog/archetypes/post  ->  blog/content/posts/<slug>/

The directory name is the URL: `blog/content/posts/my-post/` is served at
`/blog/my-post/`. Set `draft = false` when it is ready to ship — drafts are
excluded from the build, so a draft that merges to main simply does not appear.

Images go next to this file and are referenced by bare filename:

    ![Promotion flow](diagram.png)

Deleting the post directory deletes its images with it, which is the whole
reason posts are page bundles rather than flat files.
