# Exporting the Dashboard UI for the Windows Engine

The Python engine serves the dashboard as static files from `worker/ui/`.
Build the export from this repo:

## One-time setup

1. Create `next.config.export.mjs` in the repo root:

```js
import next from 'next'

/** Static export config - the REST API is provided by the Python engine. */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // NOTE: /api/* routes are NOT exported; the Python engine serves them.
}

export default nextConfig
```

2. Because API routes are not part of a static export, temporarily move
   `src/app/api` out of the tree (or guard it with an env flag), then:

```bash
npx next build          # produces ./out
```

3. Copy the output next to the engine:

```bash
mkdir -p deploy/worker/ui
cp -r out/* deploy/worker/ui/
```

4. Rebuild the engine EXE (`worker/build_exe.bat`) or simply keep `ui/` next
   to `MT5CopierEngine.exe` - the engine serves `./ui` relative to its own
   directory.

## Result

- Dashboard URL: `http://127.0.0.1:8321`
- The dashboard polls the SAME REST contract documented in
  `deploy/docs/API-CONTRACT.md`, which the Python engine implements.
- If `ui/` is missing, the engine still runs and the API responds; the root
  URL shows a hint to copy the dashboard files.

## Windows packaging note

`installer/setup.iss` and `installer/build_portable.bat` expect the UI at
`worker/ui/` inside the app folder. The Inno script also creates
`{app}\ui` with user-write permissions.
