#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { existsSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPCUAClient,
  AttributeIds,
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
  BrowseDirection,
  NodeClass
} from "node-opcua";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public"))); // absolute → works from any cwd (snap)

// ── Config (environment-driven) ─────────────────────────────────────────────────
// The same app runs on a Windows PC (HMI box) or on the CtrlX CORE itself; only
// these values differ per target, so they come from the environment. Defaults suit
// a direct/dev run against a PLC at 192.168.1.1; `.env` (npm run dev) overrides them
// locally, and snapcraft.yaml's `environment:` block overrides them on the device.

const PORT         = Number(process.env.PORT ?? 3000);
const SOCKET_PATH  = process.env.SOCKET_PATH ?? null; // set by the snap → reverse proxy connects here
const MOUNT_PATH   = process.env.BASE_PATH ?? "";     // e.g. "/hmi" behind the ctrlX reverse proxy (no prefix stripping)
const ENDPOINT_URL = process.env.OPCUA_ENDPOINT ?? "opc.tcp://192.168.1.1:4840";
const BASE_NODE    = process.env.OPCUA_BASE_NODE ?? "ns=2;s=plc/app/Application/sym/MAIN/_userInput/UserInput";
const FREQ_BASE    = process.env.OPCUA_FREQ_NODE ?? "plc/app/Application/sym/MAIN/frequencyControl"; // live frequency + accumulator status (path only; namespace taken from BASE_NODE)
const OPCUA_USER   = process.env.OPCUA_USER ?? "boschrexroth";
const OPCUA_PASS   = process.env.OPCUA_PASSWORD ?? "boschrexroth";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 5_000); // re-browse interval (auto-detect new vars)

// OPC UA security: "sign-encrypt" (default; required by the virtual core and real PLCs) or "none".
const SECURITY = (process.env.OPCUA_SECURITY ?? "sign-encrypt").toLowerCase();
const [SECURITY_MODE, SECURITY_POLICY] = SECURITY === "none"
  ? [MessageSecurityMode.None,          SecurityPolicy.None]
  : [MessageSecurityMode.SignAndEncrypt, SecurityPolicy.Basic256Sha256];

// InfluxDB historian (proxied by POST /api/query). Token comes from the environment:
// backend/.env locally (npm run dev), snapcraft.yaml's environment: block on the device.
const INFLUX_URL   = process.env.INFLUX_URL   ?? "https://192.168.1.1/influxdb";
const INFLUX_ORG   = process.env.INFLUX_ORG   ?? "eed67067a388a208";
const INFLUX_TOKEN = process.env.INFLUX_TOKEN ?? "";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // accept self-signed CtrlX certs

// ── State ─────────────────────────────────────────────────────────────────────

let client, session;
let isConnected = false;
let nodeCache   = null;   // { name: { nodeId, dataType } }
let cacheBornAt = 0;

// ── Type coercion ─────────────────────────────────────────────────────────────

const INTEGER_TYPES = new Set([
  DataType.SByte, DataType.Byte,
  DataType.Int16,  DataType.UInt16,
  DataType.Int32,  DataType.UInt32,
  DataType.Int64,  DataType.UInt64
]);

function coerce(rawValue, dataType) {
  if (dataType === DataType.Boolean) return Boolean(rawValue);
  if (dataType === DataType.String)  return String(rawValue);
  if (INTEGER_TYPES.has(dataType))   return Math.round(Number(rawValue));
  return Number(rawValue);
}

// ── OPC UA connection ─────────────────────────────────────────────────────────

async function connectOPC() {
  try {
    console.log("Connecting to OPC UA...");
    client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode:      SECURITY_MODE,
      securityPolicy:    SECURITY_POLICY,
      connectionStrategy: { initialDelay: 1000, maxRetry: 3 }
    });
    await client.connect(ENDPOINT_URL);
    session = await client.createSession({ userName: OPCUA_USER, password: OPCUA_PASS });
    isConnected = true;
    nodeCache   = null; // force re-browse on reconnect
    console.log("OPC UA connected");
  } catch (err) {
    console.error("OPC UA connection failed:", err.message);
    isConnected = false;
    setTimeout(connectOPC, 3000);
  }
}

// ── Dynamic node discovery ────────────────────────────────────────────────────
// Browses all Variable children of BASE_NODE (UserInput struct).
// Results are cached for CACHE_TTL_MS so new PLC variables appear within 5 s.

// Derives namespace prefix and base path from BASE_NODE once, used when
// constructing member node IDs via the type-definition fallback strategy.
const [, NS_PREFIX, BASE_PATH] = BASE_NODE.match(/^(ns=\d+);s=(.+)$/);

async function getNodes() {
  if (nodeCache && Date.now() - cacheBornAt < CACHE_TTL_MS) return nodeCache;

  // ── Verify BASE_NODE ──────────────────────────────────────────────────────
  const baseCheck = await session.read({ nodeId: BASE_NODE, attributeId: AttributeIds.NodeClass });
  if (!baseCheck.statusCode.isGood()) {
    console.error(`[OPC UA] BASE_NODE not found: "${BASE_NODE}" (${baseCheck.statusCode})`);
    nodeCache = {}; cacheBornAt = Date.now();
    return nodeCache;
  }
  console.log(`[OPC UA] BASE_NODE OK — NodeClass=${baseCheck.value?.value}`);

  // ── Strategy 1: BrowseDirection.Both ─────────────────────────────────────
  // CtrlX may expose member Variables with an inverse HasComponent reference
  // (Variable → parent), so Forward alone misses them.
  const browseResult = await session.browse({
    nodeId:          BASE_NODE,
    browseDirection: BrowseDirection.Both,
    includeSubtypes: true,
    resultMask:      63
  });

  const allRefs = browseResult.references ?? [];
  console.log(`[OPC UA] Browse (Both) → ${allRefs.length} reference(s):`);
  allRefs.forEach(r =>
    console.log(`  isForward=${r.isForward}  nodeClass=${r.nodeClass}  name="${r.browseName.name}"  nodeId="${r.nodeId}"`)
  );

  const directVars = allRefs.filter(r => r.isForward && r.nodeClass === NodeClass.Variable);
  if (directVars.length > 0) {
    console.log(`[OPC UA] Strategy 1 succeeded — ${directVars.length} direct Variable(s) found`);
    return await buildCache(directVars.map(r => ({ name: r.browseName.name, nodeId: r.nodeId.toString() })));
  }

  // ── Strategy 2: HasTypeDefinition → member names → construct instance IDs ─
  // UserInput is a NodeClass=Object whose type definition lists the struct
  // members. We browse the type, get member names, then build the instance
  // node IDs as  NS_PREFIX;s=BASE_PATH/memberName  and verify by reading.
  console.log(`[OPC UA] Strategy 1 found no variables — trying type definition...`);

  const typeResult = await session.browse({
    nodeId:          BASE_NODE,
    browseDirection: BrowseDirection.Forward,
    referenceTypeId: "HasTypeDefinition",
    includeSubtypes: false,
    resultMask:      63
  });

  const typeRefs = typeResult.references ?? [];
  if (typeRefs.length === 0) {
    console.error(`[OPC UA] No type definition found for UserInput. Cannot discover members.`);
    nodeCache = {}; cacheBornAt = Date.now();
    return nodeCache;
  }

  const typeNodeId = typeRefs[0].nodeId;
  console.log(`[OPC UA] UserInput type: ${typeNodeId}`);

  const typeMemberResult = await session.browse({
    nodeId:          typeNodeId,
    browseDirection: BrowseDirection.Forward,
    includeSubtypes: true,
    resultMask:      63
  });

  const typeMembers = typeMemberResult.references ?? [];
  console.log(`[OPC UA] Type members (${typeMembers.length}):`);
  typeMembers.forEach(r =>
    console.log(`  nodeClass=${r.nodeClass}  name="${r.browseName.name}"  nodeId="${r.nodeId}"`)
  );

  const varTypeMembers = typeMembers.filter(r => r.nodeClass === NodeClass.Variable);
  if (varTypeMembers.length === 0) {
    console.error(`[OPC UA] Type definition has no Variable members. Check the OPC UA address space.`);
    nodeCache = {}; cacheBornAt = Date.now();
    return nodeCache;
  }

  // Construct instance node IDs: same namespace + base path + "/" + member name
  const instanceNodes = varTypeMembers.map(r => ({
    name:   r.browseName.name,
    nodeId: `${NS_PREFIX};s=${BASE_PATH}/${r.browseName.name}`
  }));

  console.log(`[OPC UA] Strategy 2 — constructed instance node IDs:`);
  instanceNodes.forEach(n => console.log(`  ${n.name} → ${n.nodeId}`));

  return await buildCache(instanceNodes);
}

async function buildCache(nodes) {
  const dataValues = await session.read(
    nodes.map(n => ({ nodeId: n.nodeId, attributeId: AttributeIds.Value }))
  );

  const cache = {};
  for (let i = 0; i < nodes.length; i++) {
    if (dataValues[i].statusCode.isGood()) {
      cache[nodes[i].name] = {
        nodeId:   nodes[i].nodeId,
        dataType: dataValues[i].value?.dataType ?? DataType.Double
      };
    } else {
      console.warn(`[OPC UA] Could not read "${nodes[i].name}" (${nodes[i].nodeId}): ${dataValues[i].statusCode}`);
    }
  }

  nodeCache   = cache;
  cacheBornAt = Date.now();

  console.log(`[OPC UA] Discovered ${Object.keys(cache).length} variable(s):`);
  for (const [name, { nodeId, dataType }] of Object.entries(cache)) {
    console.log(`  ${name.padEnd(24)} nodeId=${nodeId}  dataType=${dataType}`);
  }

  return cache;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.send("Backend running — OPC UA: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
});

app.get("/health", (_req, res) => {
  res.json({ opcua: isConnected, endpoint: ENDPOINT_URL });
});

// Returns all discovered UserInput variables with their current PLC values
app.get("/api/params", async (_req, res) => {
  try {
    if (!session) return res.status(503).json({ error: "OPC UA not connected" });

    const nodes = await getNodes();
    const names = Object.keys(nodes);
    if (names.length === 0) return res.json([]);

    const dataValues = await session.read(
      names.map(name => ({ nodeId: nodes[name].nodeId, attributeId: AttributeIds.Value }))
    );

    res.json(names.map((name, i) => ({
      name,
      value:    dataValues[i].value?.value ?? null,
      dataType: nodes[name].dataType
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Writes a single UserInput variable by name
app.put("/api/params/:name", async (req, res) => {
  try {
    if (!session) return res.status(503).json({ error: "OPC UA not connected" });

    const { name } = req.params;
    const nodes     = await getNodes();

    if (!nodes[name]) return res.status(404).json({ error: `Parameter "${name}" not found` });

    const { nodeId, dataType } = nodes[name];

    await session.write({
      nodeId,
      attributeId: AttributeIds.Value,
      value: { value: { dataType, value: coerce(req.body.value, dataType) } }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Simulation flag: plc/.../MAIN/_simulationActive (Boolean). It lives directly under MAIN,
// outside the UserInput struct, so it needs its own read/write endpoints.
function simNodeId() {
  const MAIN = FREQ_BASE.replace(/\/[^/]+$/, "");   // parent of frequencyControl → .../MAIN
  return `${NS_PREFIX};s=${MAIN}/_simulationActive`;
}

app.get("/api/simulation", async (_req, res) => {
  try {
    if (!session) return res.status(503).json({ error: "OPC UA not connected" });
    const dv = await session.read({ nodeId: simNodeId(), attributeId: AttributeIds.Value });
    res.json({ active: dv.value?.value ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/simulation", async (req, res) => {
  try {
    if (!session) return res.status(503).json({ error: "OPC UA not connected" });
    await session.write({
      nodeId: simNodeId(),
      attributeId: AttributeIds.Value,
      value: { value: { dataType: DataType.Boolean, value: Boolean(req.body.value) } }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live data for the charts page: frequency + both accumulators in one batch read.
// frequencyControl / lowAccumulator / highAccumulator live under MAIN; the threshold
// setpoints live in the UserInput struct (BASE_PATH).
app.get("/api/monitor", async (_req, res) => {
  try {
    if (!session) return res.status(503).json({ error: "OPC UA not connected" });

    const MAIN = FREQ_BASE.replace(/\/[^/]+$/, "");   // parent of frequencyControl → .../MAIN
    const ui   = `${NS_PREFIX};s=${BASE_PATH}`;       // UserInput struct (threshold setpoints)

    const ids = [
      `${NS_PREFIX};s=${FREQ_BASE}/_frequency`,                  // 0
      `${NS_PREFIX};s=${FREQ_BASE}/_highAccumulatorActive`,      // 1
      `${ui}/_switchFreqHighThresh`,                             // 2
      `${ui}/_switchFreqLowThresh`,                              // 3
      `${NS_PREFIX};s=${MAIN}/lowAccumulator/_pressure`,         // 4
      `${ui}/_lowAccHighThresh`,                                 // 5
      `${ui}/_lowAccLowThresh`,                                  // 6
      `${NS_PREFIX};s=${MAIN}/lowAccumulator/_solenoidSwitch`,   // 7
      `${NS_PREFIX};s=${MAIN}/highAccumulator/_pressure`,        // 8
      `${ui}/_highAccHighThresh`,                                // 9
      `${ui}/_highAccLowThresh`,                                 // 10
      `${NS_PREFIX};s=${MAIN}/highAccumulator/_solenoidSwitch`   // 11
    ];
    const dv = await session.read(ids.map(nodeId => ({ nodeId, attributeId: AttributeIds.Value })));
    const v = i => dv[i].value?.value ?? null;

    res.json({
      frequency: { value: v(0), active: v(1) === true, hi: v(2), lo: v(3)  },
      lowAcc:    { value: v(4), hi: v(5),  lo: v(6),  valve: v(7)  === true },
      highAcc:   { value: v(8), hi: v(9),  lo: v(10), valve: v(11) === true }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historian: proxy a Flux query to the CtrlX InfluxDB and stream the CSV back.
app.post('/api/query', async (req, res) => {
    const { bucket, measurements, start, stop } = req.body;

    // 1. Build the Flux query string based on frontend selections
    const filterConditions = measurements.map(m => `r["_measurement"] == "${m}"`).join(' or ');
    const fluxQuery = `from(bucket: "${bucket}")
      |> range(start: ${start}, stop: ${stop})
      |> filter(fn: (r) => ${filterConditions})
      |> filter(fn: (r) => r["_field"] == "value")`;

    try {
        const response = await fetch(`${INFLUX_URL}/api/v2/query?orgID=${INFLUX_ORG}`, {
            method: 'POST',
            headers: {
                'Authorization': `Token ${INFLUX_TOKEN}`,
                'Content-Type': 'application/vnd.flux',
                'Accept': 'application/csv'
            },
            body: fluxQuery
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("InfluxDB Error:", errText);
            return res.status(response.status).json({ error: errText });
        }

        // 3. Send the InfluxDB CSV data straight back to the frontend
        const csvData = await response.text();
        res.send(csvData);

    } catch (error) {
        console.error("Backend Request Error:", error);
        res.status(500).json({ error: "Failed to connect to InfluxDB" });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────

// The ctrlX reverse proxy forwards the full prefix (e.g. /hmi) without stripping it, so
// mount the whole app under MOUNT_PATH on the device. Empty locally → served at root.
const httpApp = MOUNT_PATH ? express().use(MOUNT_PATH, app) : app;

async function onListening(where) {
  console.log(`HMI + API on ${where}${MOUNT_PATH ? ` under ${MOUNT_PATH}` : ""} — OPC UA ${ENDPOINT_URL} (${SECURITY})`);
  await connectOPC();
}

if (SOCKET_PATH) {
  // CtrlX CORE: listen on a unix socket; the device reverse proxy maps /hmi → this socket.
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); // clear a stale socket from a prior run
  httpApp.listen(SOCKET_PATH, async () => {
    chmodSync(SOCKET_PATH, 0o777); // allow the reverse proxy (a different snap) to connect
    await onListening(`socket ${SOCKET_PATH}`);
  });
} else {
  httpApp.listen(PORT, async () => { await onListening(`port ${PORT}`); });
}
