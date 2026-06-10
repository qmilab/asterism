# landing/

Served at **https://qmilab.com/asterism/** (the project Pages site owns the whole
`/asterism/*` prefix on the apex domain, so the root must ship from here, next to
`/asterism/docs/`).

- `index.html` is **self-contained** — CSS is inlined and `logo.svg` is vendored
  locally on purpose. Do **not** link the apex's hash-named stylesheet; its hash
  changes on every org-site rebuild and would silently break. Favicon/og-image
  stay apex-absolute (served by the org site).
- The `docs.yml` workflow copies `landing/.` into the Pages artifact root and
  drops this `README.md` (it's a maintainer note, not a published asset).

> **Status: placeholder.** `index.html` is a minimal scaffold so the deploy works
> end to end. Replace it with the full landing page — see
> `internal/website-plan.md` §3d (lift copy/sections from the root `README.md`).
