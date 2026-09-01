# VisClay

Part of the [Physically-Inspired Visualization](https://physically-inspired-vis.github.io/) project.

## Development

```bash
npm install --legacy-peer-deps
npm run dev
```

## Deployment

Pushing to `main` builds the site and publishes it to
<https://physically-inspired-vis.github.io/VisClay/> via GitHub Actions.

Build-time configuration comes from repository secrets:

| Secret | Purpose |
| --- | --- |
| `VITE_SERVER` | Simulation backend (Blender jobs). Without it the simulation probes cannot run. |
| `VITE_SUPABASE_URL` | Study data collection endpoint. |
| `VITE_SUPABASE_ANON_KEY` | Study data collection key. |
