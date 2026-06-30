# param-app — CtrlX CORE HMI

A web-based HMI (Human-Machine Interface) for Bosch Rexroth CtrlX CORE PLCs. A single
Node.js application serves **both** the REST/OPC-UA bridge **and** the browser HMI on one
port. Operators read and write live PLC parameters and pull historical data in a browser.

The application is designed to run **either**:

1. **On a Windows PC** on the same Ethernet network as the CtrlX PLC (the operator's HMI box), or
2. **Directly on the CtrlX CORE** itself, as an installable CtrlX app reachable from the
   device's web interface.

For development/testing today we point it at a **virtual CtrlX CORE** (CtrlX CORE Virtual /
AppBuild-Environment) instead of physical hardware.

---

## Goal & Direction (plan going forward)

> The backend and frontend are being merged into **one deployable application**: a single
> Express process serves the static HMI and the REST API from the same origin (port 3000), so
> the browser can call the API with relative URLs and no CORS/separate-host setup is needed.
> The *same* application image should run unchanged on a Windows PC or inside the CtrlX CORE —
> only configuration (PLC endpoint, security, namespace) differs between targets, and that
> configuration should move to **environment variables**.

The backend/frontend merge and env-driven config are **done** (one `app.js` + one
`public/index.html` under `backend/`). The remaining open item is the CtrlX-app (snap/Docker)
packaging, which currently fails — see **Current Status & Known Gaps** below.

---

## Architecture

```
            CtrlX CORE PLC  (real device  OR  virtual CtrlX CORE for testing)
              └─ OPC UA Server (opc.tcp://<endpoint>:4840)
              └─ InfluxDB     (https://<device>/influxdb)   ← historian
                      ▲
                      │  node-opcua  +  fetch() (Flux/REST)
                      │
        ┌─────────────┴───────────────────────────────────────────┐
        │  Single Node.js app  (Express, port 3000)                │
        │                                                          │
        │   • REST API        →  /api/params, /api/query, /health  │
        │   • Static HMI       →  serves  public/index.html         │
        └──────────────────────────────────────────────────────────┘
                      ▲  HTTP (same origin, relative URLs)
                      │
                 Browser HMI
```

Two ways to run the same app:

```
  Windows PC HMI                         CtrlX CORE app
  ──────────────                         ──────────────
  node app.js  ── Ethernet ──▶ PLC       app runs ON the device,
  browser → http://<pc>:3000             reachable from CtrlX web UI
```

The browser never speaks OPC UA directly — it only calls the app's REST endpoints.

---

## Tech Stack

| Layer       | Technology                                              |
|-------------|---------------------------------------------------------|
| Server      | Node.js 18 (ESM), Express 4                             |
| PLC link    | node-opcua (OPC UA over TCP)                            |
| Historian   | InfluxDB 2.x (Flux query, proxied via REST)            |
| HMI         | Single `index.html` — inline CSS + vanilla JS, no build |
| Packaging   | Docker image + Snap (for the CtrlX-app deployment)     |

---

## Directory Structure

```
param-app/
├── backend/                    # The single application + its packaging
│   ├── app.js                  # Server: OPC UA bridge + REST + static HMI (env-configured)
│   ├── public/
│   │   └── index.html          # The HMI (inline CSS+JS, relative API base "")
│   ├── package.json            # deps + bin "ctrlx-hmi-app"; "files" limits what the snap packs
│   ├── package-lock.json
│   ├── .env / .env.example     # local dev config (git-ignored) + template
│   ├── snapcraft.yaml          # Builds the CtrlX CORE app as a NATIVE snap (Node daemon)
│   ├── configs/
│   │   └── package-assets/
│   │       └── ctrlx-hmi-app.package-manifest.json  # sidebar menu + reverse-proxy mapping
│   ├── Dockerfile              # (optional / unused) container build, not on either deploy path
│   ├── docker-compose.yml      # (optional / unused) local container run
│   └── .dockerignore
└── CLAUDE.md
```

> Everything lives under `backend/` — one `app.js`, one `public/index.html`. The snap builds from
> this same folder, so there is a **single source of truth** (no separate
> `docker-src/` or `frontend/` copies). The HMI is one file; there is no build step.

---

## The Single Merged Application

The HMI is one self-contained `index.html` (inline CSS + JS). The server serves it as a static
file from a `public/` directory and exposes the REST API on the **same** port, so the page calls
the API with relative URLs:

```js
const API = "";                      // same-origin → "/api/params", "/health", ...
```

Express wiring:

```js
app.use(express.static('public'));   // serve the HMI
app.use(express.json());             // parse JSON bodies for writes/queries
// ... /api/params, /api/params/:name, /api/query, /health
app.listen(3000);
```

There is now **one** HMI, at `backend/public/index.html`, served by the same Express process
that exposes the API. It uses a relative API base (`const API = ""`), so opening
`http://<host>:3000/` is all that's needed — no separate dev server, no CORS.

---

## Configuration

All per-target settings are **environment variables**, read at the top of `app.js`. The same
image runs everywhere; only the env differs. Defaults suit a direct/dev run; `docker-compose.yml`
overrides them for the in-container deployment.

| Env var          | Default                                            | Purpose                                   |
|------------------|----------------------------------------------------|-------------------------------------------|
| `PORT`           | `3000`                                             | HTTP port (HMI + API)                     |
| `OPCUA_ENDPOINT` | `opc.tcp://192.168.1.1:4840`                       | PLC OPC UA endpoint                       |
| `OPCUA_SECURITY` | `sign-encrypt`                                     | `sign-encrypt` or `none`. The virtual core and real PLCs both **require `sign-encrypt`** (they expose no `None` endpoint) |
| `OPCUA_BASE_NODE`| `ns=2;s=plc/app/Application/sym/MAIN/_userInput/UserInput` | Data Layer node browsed for variables |
| `OPCUA_USER`     | `boschrexroth`                                     | OPC UA username                           |
| `OPCUA_PASSWORD` | `boschrexroth`                                     | OPC UA password                           |
| `CACHE_TTL_MS`   | `5000`                                             | re-browse interval (auto-detect new vars) |
| `INFLUX_URL`     | `https://192.168.1.1/influxdb`                     | InfluxDB base URL (historian)             |
| `INFLUX_ORG`     | `eed67067a388a208`                                 | InfluxDB org ID                           |
| `INFLUX_TOKEN`   | *(hardcoded fallback — see Known Gaps)*            | InfluxDB API token                        |

`endpoint` depends on **where the app runs relative to the PLC**: a Windows PC uses the PLC's
Ethernet IP; a container on the device reaches the device's local OPC UA via the Docker host
gateway (`172.17.0.1`).

Notes:
- **Namespace:** `ns=2` for CtrlX Data Layer Variables (was `ns=4` in older docs — node-opcua
  logs the discovered nodes on connect; verify against the live address space).
- `SECURITY=sign-encrypt` maps to `MessageSecurityMode.SignAndEncrypt` / `Basic256Sha256`;
  `none` maps to `None`/`None`. Default is secure — do **not** ship `none`.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in code so self-signed CtrlX certs are accepted.
- Default credentials are the CtrlX factory creds — set real ones via env before deploying.

On connection failure the server retries every 3 s. `/health` reports connection status.

---

## REST API

Base URL: `http://<host>:3000`

| Method | Route                 | Description                                              |
|--------|-----------------------|---------------------------------------------------------|
| GET    | `/`                   | Server status + OPC UA connection state                 |
| GET    | `/health`             | `{ opcua: bool, endpoint: string }`                     |
| GET    | `/api/params`         | All discovered `UserInput` variables (name/value/type)  |
| PUT    | `/api/params/:name`   | Writes `{ value }` to the named variable                |
| POST   | `/api/query`          | Historian: proxies a Flux query to InfluxDB, returns CSV|

### GET /api/params — response

```json
[
  { "name": "Speed",    "value": 1200, "dataType": 11 },
  { "name": "Pressure", "value": 45,   "dataType": 11 }
]
```

`dataType` is the node-opcua `DataType` enum (11 = Double, 1 = Boolean, 12 = String, …). The
HMI uses it to pick the input widget (checkbox / text / integer / float).

### PUT /api/params/:name — body

```json
{ "value": 1500 }
```

Routes by variable name. Returns `{ ok: true }` or `{ error: "..." }`. Name-based routing means
adding PLC variables never shifts indexes.

### POST /api/query — historian (InfluxDB)

```json
{ "bucket": "...", "measurements": ["Speed", "Pressure"], "start": "-1h", "stop": "now()" }
```

The server builds a Flux query, POSTs it to the CtrlX InfluxDB
(`https://<device>/influxdb/api/v2/query`), and pipes the CSV response back to the browser.

> ⚠️ The InfluxDB **auth token, org ID, and host are currently hardcoded** in the server source.
> These must move to environment variables / config — do not commit real tokens.

---

## Dynamic Discovery from the CtrlX Data Layer

All user-facing PLC variables live under one OPC UA node:

```
ns=2;s=plc/app/Application/sym/MAIN/_userInput/UserInput
```

The server browses this node's children and caches the result for `CACHE_TTL_MS` (5 s), so a new
variable added to `UserInput` in the PLC appears in the HMI within ~5 s with **no code change**.

`getNodes()` discovers members with two strategies (CtrlX address spaces vary):

1. **Browse `BrowseDirection.Both`** under `BASE_NODE` and keep forward `Variable` references.
   (CtrlX sometimes exposes members via an inverse `HasComponent` reference, so `Forward` alone
   can miss them.)
2. **Fallback — type definition:** if no direct Variables are found, browse the node's
   `HasTypeDefinition`, read the struct's member names, construct instance node IDs as
   `ns=<n>;s=<BASE_PATH>/<member>`, and verify them with a batch read.

A batch `session.read()` then fetches current values; each `DataValue.dataType` is cached as
`{ name: { nodeId, dataType } }`.

### Write type coercion (`coerce()`)

| OPC UA type        | JS coercion              |
|--------------------|--------------------------|
| Boolean            | `Boolean(value)`         |
| SByte … UInt64     | `Math.round(Number(v))`  |
| Float, Double      | `Number(value)`          |
| String             | `String(value)`          |

---

## Frontend — HMI behaviour

Single `index.html`, polling model:

- **Parameters table:** name | live value (auto-updates) | set value (input) | Write button.
- **Polling:** every 2 s, `GET /api/params`.
  - If the parameter *list* changes (var added/removed), the table is fully re-rendered.
  - If the list is unchanged, only the "Live Value" column updates — **input fields are never
    overwritten mid-entry**.
- **Input widgets** adapt to `dataType`: Boolean→checkbox, String→text, integer types→number
  `step=1`, Float/Double→number `step=any`.
- **Write flow:** edit input → "Write" → `PUT /api/params/:name` → "Written"/error for ~2.5 s.
- **Historian panel:** pick measurements + time range → `POST /api/query` → CSV results.

---

## Running the App

### A. Windows PC HMI (development / operator box)

```bash
cd backend
npm install                  # first time only
npm run dev                  # loads backend/.env, then node app.js
```

`npm run dev` runs `node --env-file=.env app.js`, reading per-target settings from `backend/.env`
(git-ignored; copy `.env.example` to start). `npm start` runs with no env file (built-in
defaults). Either way the HMI + API are served on `http://localhost:3000`, with the HMI coming
from `backend/public/` via `express.static`.

**Testing against the local virtual CtrlX CORE**, `.env` should contain:

```
OPCUA_ENDPOINT=opc.tcp://127.0.0.1:4840
OPCUA_SECURITY=sign-encrypt
INFLUX_URL=https://127.0.0.1:8443/influxdb
```

The virtual core exposes OPC UA on `127.0.0.1:4840` (SignAndEncrypt only) and its HTTPS services —
including InfluxDB at `/influxdb` — on port `8443`. For a real PLC, point these at the device IP.

### B. CtrlX CORE app (native snap)

The app is packaged as a **native snap** — Node runs directly as the snap daemon (no Docker). It
registers a sidebar entry and a reverse-proxy mapping with the device, so after install it appears
in the ctrlX web interface at **`/hmi`**.

How the pieces fit:

```
snapcraft.yaml            → npm part bundles app.js + public/ + a Node 20 runtime ($SNAP/bin/node);
                            apps.hmi runs bin/ctrlx-hmi-app as daemon:simple (plugs: network*).
app.js (SOCKET_PATH set)  → listens on a unix socket at
                            $SNAP_DATA/package-run/ctrlx-hmi-app/web.sock (chmod 0777 so the proxy
                            can connect); on-device OPC UA/Influx are on localhost.
package-manifest.json     → proxyMapping /hmi → that socket; sidebar menu entry "Parameter HMI".
content slots             → package-assets (delivers the manifest), package-run (shares the socket).
```

The HMI's relative API base (`API = ""`) means it works unchanged behind the `/hmi` proxy prefix.

**Build** (snapcraft needs Linux — you are on Windows, so use one of):
- the **ctrlX AUTOMATION App Build Environment** VM, or
- **GitHub Actions** via `boschrexroth/ctrlx-actions`.

```bash
cd backend
snapcraft                 # → ctrlx-hmi-app_1.0.0_amd64.snap
```

**Install:** device web UI → Settings → Apps → Service → upload the `.snap`. The daemon starts
automatically and "Parameter HMI" appears in the sidebar.

> First build typically needs a tweak or two (the npm part's node bundling / `bin` wiring) before
> it's clean — iterate in the build environment. The `proxyMapping` + `menus` manifest structure
> follows the Bosch SDK "Package Assets" docs.

---

## Current Status & Known Gaps

The file consolidation and native-snap packaging are **scaffolded**; remaining items:

1. **InfluxDB token still has a hardcoded fallback.** `INFLUX_TOKEN` is read from env but falls
   back to a literal token in `app.js` so the historian keeps working out of the box. Provide
   the token via env and remove the fallback before this leaves a trusted network. (OPC UA creds
   and all other config are already env-driven.)
2. **Native snap not yet built/verified on a device.** `snapcraft.yaml` is now a native Node
   daemon (no Docker) with the unix-socket + package-manifest integration, but it must be built
   in a Linux build environment and installed once to confirm the npm node-bundling, the socket
   binding, and the reverse-proxy mapping all work end-to-end.
3. **Per-target endpoints must be set via env/`.env`.** The built-in defaults (`192.168.1.1`,
   `INFLUX_URL` without `:8443`) match neither the local virtual core nor most real installs —
   they are placeholders. Always set `OPCUA_ENDPOINT` and `INFLUX_URL` for your target (see the
   virtual-core values under "Running the App"). `OPCUA_SECURITY=none` will **not** connect to the
   virtual core or a real PLC — leave it at `sign-encrypt`.

**Resolved:** the three server copies + two HMI copies are now one `app.js` + one
`public/index.html`; the live server serves `backend/public/`; per-target config moved to env
vars; the stale `app_noOpcUa.js` launch config was removed.

---

## Key Decisions & Constraints

- **One app, two targets, env-driven config.** Same code on a Windows PC or on the CtrlX CORE;
  only `ENDPOINT_URL` / security / namespace / InfluxDB settings change, via environment.
- **Same-origin frontend.** Merged HMI uses a relative API base (`const API = ""`) so no CORS
  or separate host is needed; the standalone `frontend/index.html` keeps an absolute base for
  split development.
- **Name-based write routing** — adding PLC variables never shifts indexes.
- **Dynamic discovery** — variables under `UserInput` appear automatically within ~5 s.
- **ESM throughout** — `"type": "module"`. Do not mix `require()` / CommonJS.
- **No frontend framework / no build step** — the HMI is plain HTML + JS in one file.
- **No auth on the REST API** — acceptable for a local-network HMI; add an API key if the app is
  ever exposed beyond the machine network.
