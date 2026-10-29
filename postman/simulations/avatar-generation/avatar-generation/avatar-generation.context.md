# Simulation context — avatar-generation

Updated 2026-10-29 from the local stand-ins under `postman/mocks/`.
This simulation exercises the Host avatar service against a local HTTP model;
it does not contact OpenAI and does not establish the real provider contract.

## Purpose

Stands in for the OpenAI Images API `POST /v1/images/generations` endpoint at
`api.openai.com`. It unblocks local verification of avatar request serialization,
PNG response admission, provider rate-limit mapping, and timeout behavior without
credentials or paid requests.

## Execution

```sh
# Each run uses the proxy so the service keeps its production hostname. Start
# one fixture, copy the temporary NODE_EXTRA_CA_CERTS path printed by Postman,
# then run a host-side harness for AvatarGenerationService from
# packages/agents/avatar-generation:
postman simulation run postman/simulations/avatar-generation/avatar-generation/avatar-generation.sim.yaml \
  --proxy --proxy-port 7001 --output ndjson --log-format json
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7001 \
  HTTP_PROXY=http://127.0.0.1:7001 NODE_EXTRA_CA_CERTS=<run-ca.pem> \
  AVATAR_BASE_URL=https://api.openai.com/v1 \
  <host-avatar-service-runner>

# Repeat with the dedicated failure fixtures:
postman simulation run postman/simulations/avatar-generation/avatar-generation/avatar-generation-rate-limit.sim.yaml \
  --proxy --proxy-port 7001 --output ndjson --log-format json
postman simulation run postman/simulations/avatar-generation/avatar-generation/avatar-generation-timeout.sim.yaml \
  --proxy --proxy-port 7001 --output ndjson --log-format json

# Stop the foreground simulation with Ctrl-C. The temporary proxy CA is deleted
# by Postman when the run stops; do not copy it into the repository.
```

The host harness used for the observations was ephemeral and was removed after
the run. The package service tests show the fake credentials, settings, and
attachment context needed to recreate it; this context file does not contain a
credential or a reusable runner.

The service uses a credential reference and the runner supplies only the
non-secret stand-in value `sk-simulation`; no real credential is stored here.
Node's built-in `fetch` needed `NODE_USE_ENV_PROXY=1` to honor the Postman proxy.

## Assumptions

- **Requests with no matching mock are forwarded to the real host.**
  A passing run may have hit production. Check what got called for destinations
  you didn't expect and treat them as unmocked.

- **Mocks do not hot-reload.**
  Restart the simulation after editing a handler. Restarting the service is not enough.

- **Only HTTP dependencies are simulated.**
  Databases, caches and queues must run as real local instances.

- **Port 7001 must be free, and only one simulation runs at a time.**
  Startup fails, or the service reaches the wrong proxy.

- **The stand-ins model only the response cases declared in their handlers.**
  `avatar-openai` returns one tiny valid base64 payload, the rate-limit fixture
  returns HTTP 429 with `Retry-After: 3`, and the timeout fixture waits 1500 ms
  before returning 200. None establishes the real OpenAI latency, quota, or
  response contract.

## Observations

<!-- begin:observations -->
- **Success, 2026-10-29:** `avatar-generation.sim.yaml` served one mocked
  `POST /v1/images/generations` request with HTTP 200. The real avatar service
  returned a non-durable `{ mediaType: "image/png", bytes: 4 }` preview; the
  harness then called `commit()` and received `sha256:cdcd…` with one saved
  attachment. The preview payload was `AQIDBA==`. Proxy summary: 1 mocked, 0
  passed through.
- **Rate limit, 2026-10-29:** `avatar-generation-rate-limit.sim.yaml` served
  one mocked request with HTTP 429. The real avatar service returned
  `avatar-generation/rate-limited`; no attachment was written. Proxy summary:
  1 mocked, 0 passed through.
- **Timeout, 2026-10-29:** `avatar-generation-timeout.sim.yaml` delayed its
  response by approximately 1500 ms while the service timeout was 1000 ms. The
  service returned `avatar-generation/network`; the proxy logged a client
  socket reset and later a mocked HTTP 200 after the delay. This demonstrates
  caller timeout and connection cleanup in this scenario, but does not establish
  whether a real provider completed work after a timed-out request.
<!-- end:observations -->
