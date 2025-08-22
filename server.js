const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// === TOKEN SUNWIN: lấy từ bạn cung cấp ===
const TOKEN =
"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ4b3NpZXVkZXAiLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjoyNzM1MzU3OTcsImFmZklkIjoiZGVmYXVsdCIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoic3VuLndpbiIsInRpbWVzdGFtcCI6MTc1NTc4MzMwMTY5MCwibG9ja0dhbWVzIjpbXSwiYW1vdW50IjowLCJsb2NrQ2hhdCI6ZmFsc2UsInBob25lVmVyaWZpZWQiOnRydWUsImlwQWRkcmVzcyI6IjIwMDE6ZWUwOjRmOTE6MjBkMDpiODA3OjI4ZjQ6NDZkOTpmMmUwIiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wMi5wbmciLCJwbGF0Zm9ybUlkIjo1LCJ1c2VySWQiOiI2YzJjMjMyYy02OTJiLTQ1NTktOGZiMS1kOTQ0NWUwMmU5ODQiLCJyZWdUaW1lIjoxNzUxMzU2NjYwOTkzLCJwaG9uZSI6Ijg0OTE0NzkxOTc4IiwiZGVwb3NpdCI6dHJ1ZSwidXNlcm5hbWUiOiJTQ19heG9kYXkifQ.v_7vxK55rAFU9_mKvWrDUqrZi5usTqKVTFf6ecNR6gQ";

// === CONFIG ===
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, "taixiu_history.json");

const fastify = Fastify({ logger: true });
let rikResults = [];           // lưu phiên gần nhất (tối đa 100)
let rikCurrentSession = null;  // sid hiện tại
let rikWS = null;              // WS tới SunWin
let rikIntervalCmd = null;     // interval gửi cmd 1005
let clients = new Set();       // client WS riêng của bạn

// --- Load / Save history (tùy chọn) ---
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      fastify.log.info(`Loaded ${rikResults.length} history records`);
    }
  } catch (e) { fastify.log.error(e); }
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), "utf8");
  } catch (e) { fastify.log.error(e); }
}

// --- Giải mã message có thể là binary ---
function decodeBinaryMessage(buffer) {
  try {
    const str = buffer.toString();
    if (str.startsWith("[")) return JSON.parse(str);
    let position = 0, result = [];
    while (position < buffer.length) {
      const type = buffer.readUInt8(position++);
      if (type === 1) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(buffer.toString("utf8", position, position + len));
        position += len;
      } else if (type === 2) {
        result.push(buffer.readInt32BE(position)); position += 4;
      } else if (type === 3 || type === 4) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(JSON.parse(buffer.toString("utf8", position, position + len)));
        position += len;
      } else break;
    }
    return result.length === 1 ? result[0] : result;
  } catch { return null; }
}

// --- Tính Tài/Xỉu ---
function getTX(d1, d2, d3) {
  return d1 + d2 + d3 >= 11 ? "Tài" : "Xỉu";
}

// --- Gửi lệnh lấy kết quả ---
function sendRikCmd1005() {
  if (rikWS?.readyState === WebSocket.OPEN) {
    rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
  }
}

// --- Kết nối tới SunWin WS và duy trì ---
function connectRikWebSocket() {
  fastify.log.info("Connecting to SunWin WebSocket...");
  rikWS = new WebSocket(`wss://websocket.azhkthg1.net/websocket?token=${TOKEN}`);

  rikWS.on("open", () => {
    fastify.log.info("SunWin WS connected");

    // Auth payload dùng đúng dữ liệu bạn đã gửi
    const authPayload = [
      1,
      "MiniGame",
      "SC_hoandz102",
      "123321",
      {
        info: JSON.stringify({
          ipAddress: "2001:ee0:5708:7700:8af3:abd1:fe2a:c62c",
          wsToken: TOKEN,
          userId: "0dad2f92-68a5-4597-9645-82f4bae8b4bb",
          username: "SC_hoandz102",
          timestamp: 1753460446039, // giữ nguyên theo bạn
          refreshToken: "20f613c9ce314df0b763fc6a7d174e7e.f7d8145b4d284b7a86522951ab947ea8",
        }),
        signature: "41114A7DA72204913C60C579CE12A2189D56F9598CA8EEB71E9EDB2349B7755CCCB3AC76281B36188C48F7BEEA377A8B45C46A6B03A2BF5196E060A9408D3270AAE7547F12A107FC95F122ABCB0C58FD8E8D3023E8AFAD596CBAF775FB606F81064B04F33742722864301D297D0C94F6E2BEC6A3F71F7BFA7FCA54B5387F356D",
        pid: 5,
        subi: true
      }
    ];
    rikWS.send(JSON.stringify(authPayload));

    // clear interval cũ nếu có rồi set lại
    if (rikIntervalCmd) clearInterval(rikIntervalCmd);
    rikIntervalCmd = setInterval(sendRikCmd1005, 5000);

    // ping giữ kết nối
    const ping = setInterval(() => {
      if (rikWS.readyState === WebSocket.OPEN) rikWS.ping();
      else clearInterval(ping);
    }, 15000);
  });

  rikWS.on("message", (data) => {
    try {
      const json = typeof data === "string" ? JSON.parse(data) : decodeBinaryMessage(data);
      if (!json) return;

      // Kết quả phiên mới: nằm trong json[3].res.* theo đúng schema bạn dùng
      if (Array.isArray(json) && json[3]?.res?.d1) {
        const res = json[3].res;
        if (!rikCurrentSession || res.sid > rikCurrentSession) {
          rikCurrentSession = res.sid;
          const record = {
            phien: res.sid,
            xuc_xac_1: res.d1,
            xuc_xac_2: res.d2,
            xuc_xac_3: res.d3,
            tong: res.d1 + res.d2 + res.d3,
            ket_qua: getTX(res.d1, res.d2, res.d3),
            timestamp: Date.now()
          };
          rikResults.unshift(record);
          if (rikResults.length > 100) rikResults.pop();
          saveHistory();

          fastify.log.info(`Phiên mới ${record.phien} → ${record.ket_qua}`);

          // Broadcast cho WS client riêng của bạn
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(record));
            }
          }

          // Một số cổng SunWin cần reconnect sau phiên
          setTimeout(() => {
            try { rikWS?.close(); } catch {}
          }, 1000);
        }
      }
      // Trường hợp trả về lịch sử (json[1].htr) – ta chỉ lưu nội bộ (API không trả history)
      else if (Array.isArray(json) && json[1]?.htr) {
        rikResults = json[1].htr
          .map(i => ({
            phien: i.sid,
            xuc_xac_1: i.d1,
            xuc_xac_2: i.d2,
            xuc_xac_3: i.d3,
            tong: i.d1 + i.d2 + i.d3,
            ket_qua: getTX(i.d1, i.d2, i.d3),
            timestamp: Date.now()
          }))
          .sort((a, b) => b.phien - a.phien)
          .slice(0, 100);
        saveHistory();
        fastify.log.info("Đã tải lịch sử gần nhất");
      }
    } catch (e) {
      fastify.log.error(`Parse error: ${e.message}`);
    }
  });

  rikWS.on("close", () => {
    fastify.log.warn("SunWin WS closed → reconnect in 5s");
    if (rikIntervalCmd) { clearInterval(rikIntervalCmd); rikIntervalCmd = null; }
    setTimeout(connectRikWebSocket, 5000);
  });

  rikWS.on("error", (err) => {
    fastify.log.error(`SunWin WS error: ${err.message}`);
    try { rikWS.close(); } catch {}
  });
}

// --- Khởi động ---
loadHistory();
connectRikWebSocket();
fastify.register(cors, { origin: true });

// --- HTTP API: chỉ trả phiên hiện tại ---
fastify.get("/api/taixiu/sunwin", async () => {
  const current = rikResults.find(r => r.xuc_xac_1 && r.xuc_xac_2 && r.xuc_xac_3);
  return current || { message: "Không có dữ liệu." };
});

// --- Start HTTP & WebSocket riêng (/ws) ---
const start = async () => {
  try {
    const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`HTTP API running at ${address}`);

    // WS riêng dùng chung server HTTP
    const wss = new WebSocket.Server({ server: fastify.server, path: "/ws" });

    wss.on("connection", (ws) => {
      fastify.log.info("WS client connected");
      clients.add(ws);

      // Gửi phiên hiện tại ngay khi connect
      if (rikResults.length > 0) {
        ws.send(JSON.stringify(rikResults[0]));
      }

      ws.on("close", () => {
        clients.delete(ws);
      });
      ws.on("error", () => {
        clients.delete(ws);
      });
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
