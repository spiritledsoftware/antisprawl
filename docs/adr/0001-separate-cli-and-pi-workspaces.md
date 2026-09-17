# Separate CLI and Pi workspaces

Antisprawl uses a private workspace monorepo with separately publishable CLI and Pi packages because the executable and its harness integration have different installation and dependency lifecycles. Changesets versions the packages independently. The Pi package remains a thin, Effect-free adapter that invokes `antisprawl` from `PATH`; platform-specific binary packages are still generated during release rather than maintained as source workspaces.
