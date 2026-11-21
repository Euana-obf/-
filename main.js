/**
 * 리트냥이 Hardened Obfuscator (Pure JS)
 * - No HTML
 * - No JSON config
 * - Strong Anti-Tamper / Anti-Dump / Constant Encryption
 * - Multi-layer payload
 * - Extreme minify
 *
 * Usage (Node):
 *   node main.js input.lua > out.lua
 *   or
 *   const { obfuscate } = require('./main.js')
 *   const result = obfuscate(sourceCode, options)
 */

"use strict";

/* ===================== helpers ===================== */
function rnd(min, max) {
  return (Math.random() * (max - min) + min) | 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function toLuaEscaped(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += "\\" + u8[i];
  return s;
}

function utf8Encode(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  // Node fallback
  return Buffer.from(str, "utf8");
}

/* ===================== constant & number obfuscation ===================== */
function obfuscateNumber(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  const methods = [
    () => {
      const a = rnd(100, 9000);
      return `(${n + a}-${a})`;
    },
    () => {
      const a = rnd(2, 40);
      return `(${n * a}/${a})`;
    },
    () => {
      const a = rnd(10, 500);
      const b = rnd(10, 500);
      return `(${n + a + b}-${a}-${b})`;
    },
    () => {
      // bit trick for integers
      if (Number.isInteger(n) && n >= 0 && n < 0x7fffffff) {
        const a = rnd(1, 30);
        return `(bit32 and bit32.bxor(${n ^ a},${a}) or ${n})`;
      }
      return String(n);
    }
  ];
  return methods[rnd(0, methods.length)]();
}

/* ===================== string encryption (multi layer) ===================== */
function encryptAllStrings(code) {
  const table = [];
  const re = /(["'])(?:(?=(\\?))\2.)*?\1/g;
  const map = new Map();
  let m;

  while ((m = re.exec(code)) !== null) {
    const raw = m[0];
    if (raw.length < 4 || map.has(raw)) continue;
    const body = raw.slice(1, -1);
    if (body.length < 1) continue;

    const k1 = rnd(37, 240);
    const k2 = rnd(41, 230);
    const k3 = rnd(29, 210);
    const data = [];

    for (let i = 0; i < body.length; i++) {
      let c = body.charCodeAt(i);
      c = (c ^ ((k1 + i * 13) % 251)) & 0xff;
      c = (c ^ ((k2 + i * 7) % 241)) & 0xff;
      c = (c ^ ((k3 + i * 3) % 233)) & 0xff;
      data.push(c);
    }

    const id = table.length;
    table.push([k1, k2, k3, data]);
    map.set(raw, id);
  }

  const newCode = code.replace(re, (match) => {
    if (!map.has(match)) return match;
    return `_S(${map.get(match)})`;
  });

  return { code: newCode, table };
}

/* ===================== payload packer (LZ + 3-layer XOR) ===================== */
function packPayload(str, seed) {
  const bytes = utf8Encode(str);
  const raw = [];
  const window = 8192;
  let i = 0;

  while (i < bytes.length) {
    let bestLen = 0, bestDist = 0;
    const start = Math.max(0, i - window);
    for (let j = start; j < i; j++) {
      let len = 0;
      while (len < 250 && i + len < bytes.length && bytes[j + len] === bytes[i + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = i - j;
      }
    }
    if (bestLen >= 3) {
      raw.push(0x80 | (bestLen & 0x7f));
      raw.push((bestDist >> 8) & 0xff);
      raw.push(bestDist & 0xff);
      i += bestLen;
    } else {
      raw.push(bytes[i++]);
    }
  }

  const k1 = (seed ^ 0x5a) & 0xff;
  const k2 = ((seed * 17) ^ 0xc3) & 0xff;
  const k3 = ((seed >>> 5) ^ 0x91) & 0xff;

  const out = new Uint8Array(raw.length + 14);
  out[0] = 0x52; out[1] = 0x4e; out[2] = 0x59; out[3] = 0x03; // RNY\x03
  out[4] = k1; out[5] = k2; out[6] = k3;
  const sum = adler32(bytes);
  out[7] = (sum >>> 24) & 0xff;
  out[8] = (sum >>> 16) & 0xff;
  out[9] = (sum >>> 8) & 0xff;
  out[10] = sum & 0xff;
  out[11] = (raw.length >>> 8) & 0xff;
  out[12] = raw.length & 0xff;
  out[13] = (seed >>> 16) & 0xff;

  for (let x = 0; x < raw.length; x++) {
    let v = raw[x];
    v ^= (k1 + x * 13) & 0xff;
    v ^= (k2 + x * 7) & 0xff;
    v ^= (k3 + x * 3) & 0xff;
    out[14 + x] = v;
  }
  return out;
}

/* ===================== main obfuscate ===================== */
function obfuscate(source, options = {}) {
  const opt = Object.assign({
    antiTamper: true,
    antiDump: true,
    stringEnc: true,
    constantEnc: true,
    macro: true,
    controlNoise: true,
    minify: true,
    watermark: true
  }, options);

  let code = String(source);

  // 1. String encryption
  let strTable = [];
  if (opt.stringEnc) {
    const r = encryptAllStrings(code);
    code = r.code;
    strTable = r.table;
  }

  // 2. Simple constant / number obfuscation (basic pass)
  if (opt.constantEnc) {
    code = code.replace(/\b(\d{2,})\b/g, (m) => {
      const n = Number(m);
      if (n > 10 && n < 1e9) return obfuscateNumber(n);
      return m;
    });
  }

  const seed = (Math.random() * 0x7fffffff) | 0;
  const packed = packPayload(code, seed);
  const payloadEsc = toLuaEscaped(packed);

  // ========== Anti-Tamper (Hard) ==========
  // Based on original AT + more checks. Runs only once.
  const antiTamper = opt.antiTamper ? `
local M=268435456
local function LA(v,w)v=(772109*v+99839573)%M;v=(943141*v+53826001)%M;v=(28527*v+190023955)%M;local E=542449*v+158955153;v=E%M;v=(470721*v+22251399)%M;v=(505333*v+73248309)%M;w=(w+27317064)%M;E=837995*v;v=(E+232349809)%M;v=(636017*v+93260283)%M;v=(317931*v+43492595)%M;v=(512699*v+47534657)%M;return v,w end
local function LB(v,w)v=v-v%2+1;w=(1000009*w+228639731)%M;w=(108657*w+159828783)%M;return v,w end
local function LC(w,E)w=w-w%2+1;E=(101615*E+188904345)%M;E=(499379*E+86154911)%M;return true,w,E end
local function LD(w,E)w=w-w%2+1;E=(143411*E+165109863)%M;E=(734979*E+202578441)%M;return true,w,E end
local function isN(f)if typeof and typeof(f)~="function"then return false end;if debug and debug.getinfo then local i=debug.getinfo(f);if i and i.what=="Lua"then return false end end;if is_cclosure then return is_cclosure(f)end;return true end
local NList={bit32 and bit32.band,bit32 and bit32.bxor,bit32 and bit32.rshift,bit32 and bit32.lshift,bit32 and bit32.bor,buffer and buffer.readu8,buffer and buffer.create,buffer and buffer.writeu8,string.byte,string.char,string.sub,string.gsub,string.rep,table.insert,table.concat,pcall,xpcall,type,typeof,rawget,rawset,rawequal,select,pairs,ipairs,next,setmetatable,getmetatable,error,assert,loadstring,coroutine.create,coroutine.resume,coroutine.yield,coroutine.wrap}
local function checkHooks()for i=1,#NList do if NList[i]and not isN(NList[i])then return false end end;return true end
local function checkId()local t={bit32 and bit32.band,rawget,pcall,buffer and buffer.readu8,typeof,rawequal};for i=1,#t do if t[i]and not rawequal(t[i],t[i])then return false end end;return true end
local function checkEnv()if typeof then if typeof(workspace)~="Instance"or typeof(game)~="DataModel"then return false end end;return true end
local function hasHook()return hookfunction~=nil or hookmetamethod~=nil or getrawmetatable~=nil and false end
local function crash()if task then task.spawn(function()while true do task.wait(9e9)end end)end;if coroutine then pcall(function()local c=coroutine.create(function()while true do end end);coroutine.resume(c)end)end;while true do end end
if not checkHooks()then crash()end
if not checkId()then crash()end
if not checkEnv()then crash()end
if hasHook()then crash()end
local s1,s2=LA(${seed % 9999999},${(seed * 3) % 9999999})
local s3,s4=LB(s1,s2)
local ok1,s5,s6=LC(s4,s3)
if not ok1 then crash()end
local ok2=LD(s5,s6)
if not ok2 then crash()end
` : `local function crash()while true do end end`;

  // Macro slot (user can extend)
  const macro = opt.macro ? `
local _MX={}
local function runMX()for _,f in pairs(_MX)do local ok,r=pcall(f);if not ok or r==false then return false end end;return true end
if not runMX()then crash()end
` : "";

  // String decryptor
  const strDec = opt.stringEnc ? `
local _ST=${JSON.stringify(strTable).replace(/"/g, '\\"')}
local function _S(id)local e=_ST[id+1];if not e then return""end;local k1,k2,k3,d=e[1],e[2],e[3],e[4];local t={};for i=1,#d do local c=d[i];c=c~(k3+(i-1)*3)%233;c=c~(k2+(i-1)*7)%241;c=c~(k1+(i-1)*13)%251;t[i]=string.char(c)end;return table.concat(t)end
` : "";

  // Light control noise
  const noise = opt.controlNoise ? `
local _n=0;for _i=1,4 do _n=_n+(_i*3)%7 end;if _n<0 then crash()end
` : "";

  // Decompress + execute (single time)
  const body = `
local _P="${payloadEsc}"
local function _unpack(r)
if r:byte(1)~=82 or r:byte(2)~=78 or r:byte(3)~=89 then return nil end
local k1,k2,k3=r:byte(5),r:byte(6),r:byte(7)
local body={}
for i=15,#r do
local v=r:byte(i)
v=v~(k3+((i-15)*3))&255
v=v~(k2+((i-15)*7))&255
v=v~(k1+((i-15)*13))&255
body[#body+1]=string.char(v)
end
body=table.concat(body)
local o,i={},1
while i<=#body do
local c=body:byte(i)
if c>=128 then
local l=c&127
local d=body:byte(i+1)*256+body:byte(i+2)
local s=#o-d+1
for j=1,l do o[#o+1]=o[s+j-1]end
i=i+3
else o[#o+1]=string.char(c);i=i+1 end
end
return table.concat(o)
end
local src=_unpack(_P)
if not src then crash()end
${opt.stringEnc ? `src=src:gsub("_S%((%d+)%)",function(i)return _S(tonumber(i))end)` : ""}
local fn=loadstring(src)
if not fn then crash()end
return fn()
`;

  let final = `return(function()${antiTamper}${macro}${strDec}${noise}${body}end)()`;

  // Anti-Dump name splitting
  if (opt.antiDump) {
    final = final
      .replace(/loadstring/g, "load" + "string")
      .replace(/string\.char/g, "string['\\99\\104\\97\\114']")
      .replace(/string\.byte/g, "string['\\98\\121\\116\\101']")
      .replace(/string\.sub/g, "string['\\115\\117\\98']")
      .replace(/string\.gsub/g, "string['\\103\\115\\117\\98']")
      .replace(/table\.concat/g, "table['\\99\\111\\110\\99\\97\\116']")
      .replace(/getinfo/g, "get" + "info")
      .replace(/is_cclosure/g, "is_" + "cclosure")
      .replace(/hookfunction/g, "hook" + "function")
      .replace(/hookmetamethod/g, "hook" + "metamethod")
      .replace(/rawequal/g, "raw" + "equal")
      .replace(/typeof/g, "type" + "of")
      .replace(/getrawmetatable/g, "get" + "rawmetatable");
  }

  // Extreme minify
  if (opt.minify) {
    final = final
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .replace(/ ?([{}()\[\],;=<>~+\-*/%|&!]) ?/g, "$1")
      .replace(/;+/g, ";")
      .trim();
  }

  if (opt.watermark) {
    final = `--[[RNY]]` + final;
  }

  return final;
}

/* ===================== Render Web Server + CLI ===================== */
if (typeof require !== "undefined" && require.main === module) {
  const fs = require("fs");
  const args = process.argv.slice(2);

  // If input arguments are supplied, preserve the original CLI behavior.
  if (args.length > 0) {
    const input = fs.readFileSync(args[0], "utf8");
    const result = obfuscate(input);
    if (args[1]) {
      fs.writeFileSync(args[1], result);
      console.error("[리트냥이] saved →", args[1]);
    } else {
      process.stdout.write(result);
    }
  } else {
    // Render Web Service mode: no input file is expected.
    const http = require("http");
    const PORT = Number(process.env.PORT) || 3000;
    const MAX_BODY = 1_000_000;

    const page = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>리트냥이 Lua Obfuscator</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;padding:28px}
main{max-width:900px;margin:0 auto}h1{font-size:25px}p{color:#9da7b3}textarea{width:100%;min-height:280px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:14px;font:13px/1.5 monospace;resize:vertical}
button{margin:12px 8px 12px 0;padding:11px 18px;border:0;border-radius:8px;background:#8b5cf6;color:white;font-weight:700;font-size:14px}button:disabled{opacity:.6}#status{min-height:24px}label{display:block;margin:16px 0 8px;font-weight:600}
</style></head><body><main><h1>리트냥이 Lua / Luau Obfuscator</h1><p>Lua 코드를 입력하고 난독화 버튼을 눌러주세요.</p>
<label for="source">원본 코드</label><textarea id="source" placeholder="-- Lua / Luau code"></textarea>
<button id="run">난독화하기</button><button id="copy" type="button">결과 복사</button><div id="status" role="status"></div>
<label for="result">난독화 결과</label><textarea id="result" readonly placeholder="결과가 여기에 표시됩니다"></textarea>
<script>
const run=document.getElementById('run'),src=document.getElementById('source'),out=document.getElementById('result'),status=document.getElementById('status');
run.addEventListener('click',async()=>{if(!src.value.trim()){status.textContent='먼저 Lua 코드를 입력해주세요.';return}run.disabled=true;status.textContent='처리 중...';try{const r=await fetch('/obfuscate',{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body:src.value});const data=await r.text();if(!r.ok)throw new Error(data||'요청에 실패했습니다.');out.value=data;status.textContent='난독화가 완료됐습니다.'}catch(e){status.textContent='오류: '+e.message}finally{run.disabled=false}});
document.getElementById('copy').addEventListener('click',async()=>{if(!out.value){status.textContent='복사할 결과가 없습니다.';return}try{await navigator.clipboard.writeText(out.value);status.textContent='결과를 복사했습니다.'}catch(e){status.textContent='복사 권한이 없어 직접 선택해 복사해주세요.'}});
</script></main></body></html>`;

    const server = http.createServer((req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page);
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("OK");
      }
      if (req.method === "POST" && req.url === "/obfuscate") {
        let body = "";
        req.on("data", chunk => {
          body += chunk;
          if (Buffer.byteLength(body) > MAX_BODY) {
            res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("요청 크기가 너무 큽니다. 1MB 이하로 입력해주세요.");
            req.destroy();
          }
        });
        req.on("end", () => {
          if (res.writableEnded) return;
          try {
            if (!body.trim()) {
              res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
              return res.end("Lua 코드를 입력해주세요.");
            }
            const output = obfuscate(body, {});
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(output);
          } catch (err) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(err.message || "난독화 처리 중 오류가 발생했습니다.");
          }
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`[리트냥이] Web server listening on port ${PORT}`);
    });
  }
}

// Export for require / import
if (typeof module !== "undefined") {
  module.exports = { obfuscate };
}
