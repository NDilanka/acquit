// Ownership proof, not a marker. Inside the child this preload opens a private
// channel named by the nonce it was given and answers a challenge with this
// process's own pid (and its parent pid). A bystander that merely carries the
// nonce in its command line never opens the channel, so it cannot answer.
// The nonce arrives as a script argument after `--`, which neither Node nor
// Vite parses. No command-line inspection happens anywhere in this proof.
const { createServer } = require("node:net");
const { unlinkSync } = require("node:fs");

const nonce = process.argv[process.argv.length - 1];
if (!/^[0-9a-f]{32}$/.test(nonce)) return;

const path = process.platform === "win32" ? `\\\\.\\pipe\\acquit-${nonce}` : process.env.ACQUIT_OWNERSHIP_SOCKET;
if (!path) return;
if (process.platform !== "win32") { try { unlinkSync(path); } catch {} }

const server = createServer(socket => {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		if (!buffer.includes("\n")) return;
		// Answer only the exact challenge. Anything else gets silence.
		if (buffer.slice(0, buffer.indexOf("\n")) === "prove") socket.end(`${process.pid} ${process.ppid}\n`);
		else socket.end();
	});
	socket.on("error", () => {});
});
server.on("error", () => {});
// The channel must not keep a finished service alive, and it must be ready
// before the service binds its own ports: listen is synchronous for a pipe.
server.unref();
server.listen(path);
