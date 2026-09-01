# VisClay

Part of the [Physically-Inspired Visualization](https://physically-inspired-vis.github.io/) project.

## Development

The deform, shatter and fluid probes drive Blender through a small Express
server. Run both, in two terminals:

```bash
npm install --legacy-peer-deps

npm run server   # Blender jobs, on http://localhost:3001
npm run dev      # the site, on http://localhost:5173/visclay/
```

In dev the client falls back to `http://localhost:3001`, so nothing needs
configuring - no tunnel, no secrets. Particles need no server at all.

Blender must be installed. The server looks in the default location per
platform; override it with `BLENDER_PATH` if yours lives elsewhere:

```bash
BLENDER_PATH="/path/to/blender" npm run server
```

## Deployment

Pushing to `main` builds the site and publishes it to
<https://physically-inspired-vis.github.io/visclay/> via GitHub Actions.

Build-time configuration comes from repository secrets:

| Secret | Purpose |
| --- | --- |
| `VITE_SERVER` | Simulation backend (Blender jobs). Without it the simulation probes cannot run. |
| `VITE_SUPABASE_URL` | Study data collection endpoint. |
| `VITE_SUPABASE_ANON_KEY` | Study data collection key. |
