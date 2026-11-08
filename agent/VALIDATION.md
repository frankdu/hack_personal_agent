# Scaffold validation

Validated November 7, 2026 on macOS with Node 24.22.2 and Docker Desktop (Linux ARM64 containers).

| Check | Result |
|---|---|
| Root dependency installation and npm lockfile | Passed |
| `npm run check` | Passed: shared/node/frontend builds, TypeScript checks, 3 node tests |
| PROD and DEV Compose configuration, including optional node profile | Passed |
| PROD frontend and node Docker image builds | Passed |
| DEV Docker target builds | Passed |
| PROD frontend container | HTTP 200 and expected server-rendered empty-fleet content |
| PROD node container | Liveness 200; readiness 503 with execution not implemented |
| DEV frontend container | Vite startup and HTTP 200 with expected content |
| Native built frontend | HTTP 200 with expected page title and disconnected state |
| Isolated PostgreSQL Compose instance | Healthy using PostgreSQL 18 volume layout |
| Production dependency audit | Zero reported vulnerabilities |
| Full dependency audit | Six development-tool findings: 2 low, 4 moderate, in shadcn's transitive dependency chain |

The full audit includes deepmerge and minimatch advisories. No forced major downgrade or unverified transitive override was applied to the requested current shadcn release. Recheck the registry before a release.

The first HTTP integration-test attempt was blocked by the execution sandbox's loopback restriction; the full check passed with loopback access. A browser preview was attempted, but the browser access host was unavailable. Visual layout and browser interaction/hydration remain unverified; HTTP checks establish server rendering only.

GPU inference, Linux x86/NVIDIA behavior, model downloads, backend registration, routing and actual chat execution are outside this scaffold's implemented surface. They are acceptance checks in the research backlog. No LLM request was sent during validation.

Temporary test containers and the native preview server were stopped after validation. Build images and dependency caches remain available locally.
