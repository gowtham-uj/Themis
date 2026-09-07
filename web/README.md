# Themis console

The console is a React client for the Themis HTTP API. It does not keep its own backend state.

## Run locally

Start the API from the repository root:

```bash
npm run serve -- --port 8080 --data-dir ./data
```

Then start Vite:

```bash
cd web
npm ci
npm run dev -- --host 0.0.0.0
```

The Vite development server proxies `/api` to `http://127.0.0.1:8080`.

## Production build

```bash
npm ci
npm run lint
npm run build
npm run preview -- --host 0.0.0.0
```

`dist/` contains the static bundle. Deploy it behind the same origin as the API, or configure the reverse proxy so `/api` reaches the Themis server.

## Main routes

| Route | Purpose |
|---|---|
| `/projects` | Projects and recent run state. |
| `/projects/:id` | Project overview and run history. |
| `/projects/:id/settings` | Agent, model stages, Serper variable, and judge prompts. |
| `/projects/:id/evals` | Project eval packages. |
| `/projects/:id/queue` | Queue blueprint and stage automation. |
| `/projects/:id/runs/:generationId` | Live run panel across eval execution, Phase 1, and Phase 2. |
| `/eval-store` | Reusable canonical eval packages. |
| `/archives` | Archive catalog. |
| `/archives/:runId` | Collapsible archive tree and file viewer. |
| `/models` | Deployment-wide model defaults. |

## Checks

```bash
npm run lint
npm run build
```

Console changes should also be checked with keyboard navigation and at narrow and wide viewport sizes. Include screenshots from real API data in pull requests.
