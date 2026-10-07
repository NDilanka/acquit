#!/usr/bin/env node
// The one route out of the runner's internal network. The runner container can reach nothing else:
// its network has no gateway, so every HTTPS request it makes is a CONNECT to this proxy, and this
// proxy dials upstream only for the package registry and the model provider, only on the ports the
// allowlist names.
//
// A denial answers 403 and names the host on stdout, so a lane transcript shows what was refused.
// Request paths and headers are never logged: an npm token or an API key could ride in them.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { allowedConnect, allowedForward, ALLOWED_HOSTS, parseAuthority } from "./allowlist.mjs";

const PORT = Number(process.env.ACQUIT_PROXY_PORT ?? 8888);

const server = createServer((req, res) => {
	let target;
	try { target = new URL(req.url); } catch { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad proxy request\n"); return; }
	const port = target.port === "" ? 80 : Number(target.port);
	if (!allowedForward(target.hostname, port)) {
		console.log(`deny http ${target.hostname}:${port}`);
		res.writeHead(403, { "content-type": "text/plain" });
		res.end(`egress denied: ${target.hostname}\n`);
		return;
	}
	const upstream = httpRequest({ host: target.hostname, port, method: req.method,
		path: `${target.pathname}${target.search}`, headers: req.headers }, answer => {
		res.writeHead(answer.statusCode ?? 502, answer.headers);
		answer.pipe(res);
	});
	upstream.on("error", error => {
		console.log(`fail http ${target.hostname}: ${error.message}`);
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end("upstream failed\n");
	});
	req.pipe(upstream);
});

server.on("connect", (req, client, head) => {
	const target = parseAuthority(req.url);
	if (target === null || !allowedConnect(req.url)) {
		console.log(`deny connect ${req.url}`);
		client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const upstream = connect(target.port, target.host, () => {
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head?.length) upstream.write(head);
		upstream.pipe(client);
		client.pipe(upstream);
	});
	upstream.on("error", error => {
		console.log(`fail connect ${target.host}: ${error.message}`);
		client.end();
	});
	client.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`acquit egress proxy on ${PORT}: ${[...ALLOWED_HOSTS].join(", ")}`));
