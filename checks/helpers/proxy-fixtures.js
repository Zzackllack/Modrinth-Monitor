const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const { once } = require("node:events");
const { splitHostPort } = require("../../src/egress/proxy-model");

/**
 * Minimal forward proxy for tests: absolute-form GET for plain HTTP and CONNECT
 * tunnelling for anything else. Keeps counters so tests can assert that traffic
 * really went through it.
 */
async function startHttpProxy() {
  const stats = { requests: 0, connects: 0, urls: [] };

  const server = http.createServer((request, response) => {
    stats.requests += 1;
    stats.urls.push(request.url);

    let target;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("absolute-form request required");
      return;
    }

    if (target.protocol !== "http:") {
      response.writeHead(400).end();
      return;
    }

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
      }
    );

    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("connect", (request, clientSocket, head) => {
    stats.connects += 1;
    const parsed = splitHostPort(request.url);
    if (!parsed) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const upstream = net.connect(Number(parsed.port), parsed.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** Proxy that always rejects CONNECT, for negative checks. */
async function startRejectingProxy() {
  const server = http.createServer((request, response) => {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("denied");
  });

  server.on("connect", (request, clientSocket) => {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** Proxy that accepts TCP but never speaks, for timeout checks. */
async function startSilentProxy() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** HTTPS proxy (TLS to the proxy) with a self-signed certificate. */
async function startTlsProxy({ key, cert }) {
  const sockets = new Set();

  const server = tls.createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) return;

      const [requestLine] = buffer
        .subarray(0, headEnd)
        .toString("latin1")
        .split("\r\n");
      const rest = buffer.subarray(headEnd + 4);
      socket.off("data", onData);

      const [, authority] = requestLine.split(" ");
      const parsed = splitHostPort(authority || "");
      if (!parsed) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      const upstream = net.connect(Number(parsed.port), parsed.host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
    };

    socket.on("data", onData);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

/** SOCKS5 server that only supports unauthenticated CONNECT. */
async function startSocks5Proxy({ rejectMethods = false } = {}) {
  const stats = { connects: 0 };

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greeting";

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);

        if (rejectMethods) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }

        socket.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }

      if (stage === "request") {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let offset = 4;
        let host;

        if (atyp === 0x01) {
          if (buffer.length < 8) return;
          host = [...buffer.subarray(4, 8)].join(".");
          offset = 8;
        } else if (atyp === 0x04) {
          if (buffer.length < 20) return;
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        } else if (atyp === 0x03) {
          const length = buffer[4];
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString("utf8");
          offset = 5 + length;
        } else {
          socket.destroy();
          return;
        }

        if (buffer.length < offset + 2) return;
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        stage = "tunnel";
        socket.off("data", onData);

        const upstream = net.connect(port, host, () => {
          stats.connects += 1;
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buffer.length) upstream.write(buffer);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
      }
    };

    socket.on("data", onData);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/** Origin server used as the tunnel target. */
async function startOriginServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

async function findClosedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

module.exports = {
  findClosedPort,
  startHttpProxy,
  startOriginServer,
  startRejectingProxy,
  startSilentProxy,
  startSocks5Proxy,
  startTlsProxy,
};
