'use strict';
// Trusted transport. The candidate receives only one input and retained functions.
// Docker, not node:vm, supplies the security boundary. No host volume is mounted.
const fs = require('node:fs');
const vm = require('node:vm');
const {TextEncoder, TextDecoder} = require('node:util');
const allowed = new Set(['assert','buffer','crypto','util','zlib','string_decoder']);
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const calls = Object.create(null);
function compile(source, label) {
  const module = {exports:{}};
  const sandbox = {module, exports:module.exports, Buffer, TextEncoder, TextDecoder,
    require(name) {
      const id = name.replace(/^node:/, '');
      if (!allowed.has(id)) throw new Error('Module unavailable: '+name);
      return require('node:'+id);
    }};
  const ctx = vm.createContext(sandbox, {codeGeneration:{strings:false,wasm:false}});
  vm.runInContext(source, ctx, {timeout:1000,filename:label});
  const fn = typeof module.exports === 'function' ? module.exports :
    (module.exports.transform || ctx.transform);
  if (typeof fn !== 'function') throw new Error('Export transform(input, lib)');
  return fn;
}
try {
  const retained = Object.create(null);
  for (const [id, source] of Object.entries(payload.retained || {})) {
    const fn = compile(source, id+'.cjs'); calls[id] = 0;
    retained[id] = input => {calls[id]++; return fn(input, Object.freeze({}));};
  }
  const fn = compile(payload.source, 'candidate.cjs');
  const input = payload.binary ? Buffer.from(payload.input, 'base64') : payload.input;
  const out = fn(input, Object.freeze(retained));
  if (typeof out !== 'string') throw new Error('Return value must be a synchronous string');
  if (Buffer.byteLength(out)>1048576) throw new Error('Output exceeds 1 MiB');
  process.stdout.write(JSON.stringify({ok:true,output:out,calls}));
} catch(e) {
  process.stdout.write(JSON.stringify({ok:false,error:String(e.message).slice(0,1000),calls}));
}
