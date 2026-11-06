/**
 * 极简本地 HTTP/CONNECT 代理
 * ---------------------------------------------------------------
 * 背景：本机 Chrome 直连东方财富的 IP 时 TCP/TLS 握手会卡死 30s 以上，
 *       而 Node 直连同一 IP 只需 50ms。用一个本地 CONNECT 代理把浏览器
 *       流量转交给 Node 的 socket，可绕过 Chrome 网络栈的问题。
 *
 * 额外好处：所有请求都经过这里，天然就是一份抓包日志。
 *
 * 用法： node scripts/net_proxy.mjs [port]
 *       默认 8899；日志 logs/proxy.log
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.argv[2] || 8899);
const ROOT = path.resolve(import.meta.dirname, "..");
const LOG = path.join(ROOT, "logs/proxy.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + "\n");
}

const server = net.createServer((client) => {
  client.once("data", (buf) => {
    const head = buf.toString("latin1");
    const firstLine = head.split("\r\n")[0] || "";
    const [method, target] = firstLine.split(" ");

    if (method === "CONNECT") {
      const [host, portStr] = String(target).split(":");
      const port = Number(portStr) || 443;
      const upstream = net.connect({ host, port });
      upstream.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        log(`CONNECT ${host}:${port}`);
        // 客户端可能已经把 TLS 数据放在同一个包里发过来了
        const rest = buf.subarray(head.indexOf("\r\n\r\n") + 4);
        if (rest.length) upstream.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      const fail = (e) => {
        log(`ERR CONNECT ${host}:${port} ${e?.code || e?.message || e}`);
        try { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
        try { upstream.destroy(); } catch {}
      };
      upstream.on("error", fail);
      client.on("error", () => upstream.destroy());
    } else {
      // 明文 HTTP：首行形如 GET http://host/path HTTP/1.1
      try {
        const u = new URL(target);
        const upstream = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
        upstream.on("connect", () => {
          const rest = buf.subarray(head.indexOf("\r\n\r\n") + 4);
          const rewritten = head
            .replace(target, u.pathname + u.search || "/")
            .replace(/\r\nProxy-Connection:[^\r\n]*/i, "");
          upstream.write(rewritten);
          if (rest.length) upstream.write(rest);
          upstream.pipe(client);
          client.pipe(upstream);
          log(`HTTP ${u.hostname}${u.pathname}`);
        });
        upstream.on("error", (e) => {
          log(`ERR HTTP ${u.hostname} ${e.code}`);
          try { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
        });
        client.on("error", () => upstream.destroy());
      } catch (e) {
        log("ERR bad request " + firstLine);
        try { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
      }
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`proxy listening on http://127.0.0.1:${PORT}`);
  log(`listening ${PORT}`);
});
