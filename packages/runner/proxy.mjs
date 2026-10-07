#!/usr/bin/env node
// The one route out of the runner's internal network. The runner container can reach nothing else:
// its network has no gateway, so every HTTPS request it makes is a CONNECT to this proxy, and this
// proxy dials upstream only for the package registry and the model provider.
//
// A denial answers 403 and names the host on stdout, so a lane transcript shows what was refused.
// Request paths and headers are never logged: an npm token or an API key could ride in them.

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const PORT = Number(process.env.ACQUIT_PROXY_PORT ?? 8888);
const ALLOWED = new Set(["registry.npmjs.org", "api.anthropic.com"]);

/** Exact host names only: a suffix match would let a lookalike through. */
function allowedHost(host) {
	return ALLOWED.has(String(host).toLowerCase().replace(/\.$/, ""));
}

const server = createServer((req, res) => {
	let target;
	try { target = new URL(req.url); } catch { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad proxy request\n"); return; }
	if (!allowedHost(target.hostname)) {
		console.log(`deny http ${target.hostname}`);
		res.writeHead(403, { "content-type": "text/plain" });
		res.end(`egress denied: ${target.hostname}\n`);
		return;
	}
	const upstream = httpRequest({ host: target.hostname, port: target.port || 80, method: req.method,
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
	const [host, portRaw] = req.url.split(":");
	const port = Number(portRaw) || 443;
	if (!allowedHost(host)) {
		console.log(`deny connect ${host}`);
		client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
		return;
	}
	const upstream = connect(port, host, () => {
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head?.length) upstream.write(head);
		upstream.pipe(client);
		client.pipe(upstream);
	});
	upstream.on("error", error => {
		console.log(`fail connect ${host}: ${error.message}`);
		client.end();
	});
	client.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log(`acquit egress proxy on ${PORT}: ${[...ALLOWED].join(", ")}`));
