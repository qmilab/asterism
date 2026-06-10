# landing/

Served at **https://qmilab.com/asterism/** (the project Pages site owns the whole
`/asterism/*` prefix on the apex domain, so the root must ship from here, next to
`/asterism/docs/`).

- `index.html` is **self-contained** — CSS is inlined and the nav logo
  (`logo.png`, QMI Lab) is vendored locally on purpose. Do **not** link the
  apex's hash-named stylesheet; its hash changes on every org-site rebuild and
  would silently break. Favicon/og-image stay apex-absolute (served by the org
  site).
- The structure mirrors `lodestar/landing/index.html` so the two project pages
  read as one site.
- The `docs.yml` workflow copies `landing/.` into the Pages artifact root and
  drops this `README.md` (it's a maintainer note, not a published asset).
