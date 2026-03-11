const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { SerialPort, ReadlineParser } = require("serialport");

const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 115200);
const SERIAL_PORT_ENV = process.env.SERIAL_PORT || null;
const SERIAL_RETRY_MS = 2500;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

let serialPort = null;
let parser = null;
let activePortPath = null;
let lastValue = null;
let serialConnected = false;
let reconnectTimer = null;
let lastLineAt = null;

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function broadcastStatus() {
  broadcast({
    type: "status",
    serialConnected,
    activePortPath,
    baudRate: SERIAL_BAUD,
    lastValue,
    lastLineAt,
    clients: wss.clients.size,
    now: Date.now(),
  });
}

function broadcastValue(n) {
  broadcast({
    type: "value",
    value: n,
    ts: Date.now(),
    port: activePortPath,
  });
}

async function listCandidatePorts() {
  const ports = await SerialPort.list();

  const preferred = [];
  const others = [];

  for (const p of ports) {
    const pth = p.path || "";
    if (
      //pth.startsWith("/dev/cu.usbserial") ||
      pth.startsWith("/dev/tty.usbmodem")
    ) {
      preferred.push(p);
    } else {
      others.push(p);
    }
  }

  preferred.sort((a, b) => (a.path || "").localeCompare(b.path || ""));
  others.sort((a, b) => (a.path || "").localeCompare(b.path || ""));

  return [...preferred, ...others];
}

async function choosePortPath() {
  if (SERIAL_PORT_ENV) return SERIAL_PORT_ENV;

  const ports = await listCandidatePorts();
  if (!ports.length) return null;

  return ports[0].path;
}

function cleanupSerial() {
  try {
    if (parser) {
      parser.removeAllListeners();
      parser = null;
    }
  } catch {}

  try {
    if (serialPort) {
      serialPort.removeAllListeners();
      if (serialPort.isOpen) {
        serialPort.close(() => {});
      }
      serialPort = null;
    }
  } catch {}

  activePortPath = null;
  serialConnected = false;
  broadcastStatus();
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connectSerial();
  }, SERIAL_RETRY_MS);
}

async function connectSerial() {
  cleanupSerial();

  let portPath;
  try {
    portPath = await choosePortPath();
  } catch (err) {
    log("Error listando puertos:", err.message);
    scheduleReconnect();
    return;
  }

  if (!portPath) {
    log("No se encontró puerto serie. Reintentando...");
    scheduleReconnect();
    return;
  }

  activePortPath = portPath;
  log("Intentando abrir serie:", activePortPath, "baud:", SERIAL_BAUD);

  try {
    serialPort = new SerialPort({
      path: activePortPath,
      baudRate: SERIAL_BAUD,
      autoOpen: false,
    });

    serialPort.on("error", (err) => {
      log("Error serie:", err.message);
      serialConnected = false;
      broadcastStatus();
      scheduleReconnect();
    });

    serialPort.on("close", () => {
      log("Puerto serie cerrado");
      serialConnected = false;
      broadcastStatus();
      scheduleReconnect();
    });

    serialPort.open((err) => {
      if (err) {
        log("No se pudo abrir serie:", err.message);
        serialConnected = false;
        broadcastStatus();
        scheduleReconnect();
        return;
      }

      serialConnected = true;
      lastLineAt = Date.now();
      log("Serie abierta:", activePortPath);
      broadcastStatus();

      parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

      parser.on("data", (line) => {
        const txt = String(line).trim();
        const n = parseInt(txt, 10);

        if (!Number.isNaN(n)) {
          lastValue = n;
          lastLineAt = Date.now();
          broadcastValue(n);
        }
      });

      parser.on("error", (err) => {
        log("Error parser:", err.message);
      });
    });
  } catch (err) {
    log("Fallo creando SerialPort:", err.message);
    serialConnected = false;
    broadcastStatus();
    scheduleReconnect();
  }
}

wss.on("connection", (ws) => {
  log("Cliente WS conectado. Total:", wss.clients.size);

  ws.send(JSON.stringify({
    type: "status",
    serialConnected,
    activePortPath,
    baudRate: SERIAL_BAUD,
    lastValue,
    lastLineAt,
    clients: wss.clients.size,
    now: Date.now(),
  }));

  if (lastValue !== null) {
    ws.send(JSON.stringify({
      type: "value",
      value: lastValue,
      ts: Date.now(),
      port: activePortPath,
    }));
  }

  ws.on("close", () => {
    log("Cliente WS desconectado. Total:", wss.clients.size);
    broadcastStatus();
  });
});

app.get("/api/status", async (req, res) => {
  let availablePorts = [];
  try {
    const ports = await listCandidatePorts();
    availablePorts = ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || "",
      serialNumber: p.serialNumber || "",
      vendorId: p.vendorId || "",
      productId: p.productId || "",
    }));
  } catch {}

  res.json({
    ok: true,
    serialConnected,
    activePortPath,
    baudRate: SERIAL_BAUD,
    lastValue,
    lastLineAt,
    clients: wss.clients.size,
    availablePorts,
    now: Date.now(),
  });
});

server.listen(HTTP_PORT, "0.0.0.0", async () => {
  log(`Web escuchando en http://0.0.0.0:${HTTP_PORT}`);
  await connectSerial();
});

process.on("SIGINT", () => {
  log("Cerrando...");
  cleanupSerial();
  process.exit(0);
});