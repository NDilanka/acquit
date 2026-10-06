import { createInterface } from 'node:readline';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const parse = JSON.parse.bind(JSON);
const encode = JSON.stringify.bind(JSON);
const write = process.stdout.write.bind(process.stdout);
const root = resolve(process.argv[2]);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const modules = new Map();
let count = 0;
for await (const line of input) {
  if (++count > 54 || Buffer.byteLength(line) > 8192) process.exit(2);
  let call;
  try {
    call = parse(line);
    if (!call || Object.keys(call).sort().join(',') !== 'args,id,target'
        || typeof call.id !== 'string' || !Array.isArray(call.args)
        || Object.keys(call.target ?? {}).sort().join(',') !== 'export,module'
        || typeof call.target.module !== 'string' || typeof call.target.export !== 'string') {
      throw new Error('Malformed SubjectCall');
    }
    const path = resolve(root, call.target.module);
    if (!path.startsWith(root + sep)) throw new Error('Target escapes tree');
    let module = modules.get(path);
    if (!module) {
      module = await import(pathToFileURL(path).href);
      modules.set(path, module);
    }
    if (typeof module[call.target.export] !== 'function') throw new Error('Export is not callable');
    const value = await module[call.target.export](...call.args);
    const encoded = encode({ id: call.id, ok: true, value });
    if (Buffer.byteLength(encoded) > 8192) throw new Error('Reply too large');
    write(encoded + '\n');
  } catch (error) {
    write(encode({ id: call?.id ?? '', ok: false, error: String(error).slice(0, 1024) }) + '\n');
  }
}
