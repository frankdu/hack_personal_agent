## Prepare the workspace once

Start Docker Desktop. Use Node 24 and npm 11, then:

```
# cd this dir
npm ci
npm run setup:local
# Then configure .env file.
```

## Spin up the db

```
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres18
# pg is available at 127.0.0.1:55432. Backend migrations run automatically.
```

## Start the native dev services

```
MODE=DEV npm run dev
```

## Connect through the frontend

Enter:
• Backend URL: http://127.0.0.1:3100
• Token: your existing API_TOKEN from agent/.env

You can test connection and fleet behavior immediately. Chat needs a ready model.

## Connect a model for actual chat

First run a local OpenAI-compatible inference server. The current implementation does not install or download Gemma automatically.

```
# Check its advertised model ID:
curl http://127.0.0.1:8080/v1/models
```

To test hosted routing judgments, also set:
JEV_API_KEY=your-key

One eligible node bypasses Jev. Testing Jev selection requires multiple eligible placements and hosted judgment enabled in the UI.

## Test and stop

```
npm run check
npm run test:integration
```

Integration tests need no real model or paid API calls.

Stop development processes with Ctrl-C, then stop PostgreSQL while retaining its data:

```
docker compose -f compose.yaml -f compose.dev.yaml stop postgres18
```
