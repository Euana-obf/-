/**
 * 리트냥이 Hardened Obfuscator v5
 * 웹 전용: node main.js  →  http://localhost:3000
 * 업로드 → 난독화 → 다운로드
 */

"use strict";

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

function rollHash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function toLuaEscaped(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += "\\" + u8[i];
  return s;
}

function utf8Encode(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  return Buffer.from(str, "utf8");
}

function obfuscateNumber(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  const methods = [
    () => { const a = rnd(100, 9000); return `(${n + a}-${a})`; },
    () => { const a = rnd(2, 40); return `(${n * a}/${a})`; },
    () => {
      const a = rnd(10, 500), b = rnd(10, 500);
      return `(${n + a + b}-${a}-${b})`;
    },
    () => {
      if (Number.isInteger(n) && n >= 0 && n < 0x7fffffff) {
        const a = rnd(1, 30);
        return `(bit32 and bit32.bxor(${n ^ a},${a}) or ${n})`;
      }
      return String(n);
    }
  ];
  return methods[rnd(0, methods.length)]();
}

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
    const k1 = rnd(37, 240), k2 = rnd(41, 230), k3 = rnd(29, 210);
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
  const newCode = code.replace(re, (match) => map.has(match) ? `_S(${map.get(match)})` : match);
  return { code: newCode, table };
}

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
      if (len > bestLen) { bestLen = len; bestDist = i - j; }
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
  out[0] = 0x52; out[1] = 0x4e; out[2] = 0x59; out[3] = 0x03;
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

function multiPack(str, seed, layers) {
  let cur = str;
  let s = seed;
  for (let i = 0; i < layers; i++) {
    const packed = packPayload(cur, s);
    cur = String.fromCharCode.apply(null, packed);
    s = (s * 0x9e3779b9 + 0x7f4a7c15) >>> 0;
  }
  return utf8Encode(cur);
}

function split4(u8) {
  const n = u8.length;
  const a = Math.floor(n / 4);
  const b = Math.floor((n - a) / 3);
  const c = Math.floor((n - a - b) / 2);
  return [
    u8.slice(0, a),
    u8.slice(a, a + b),
    u8.slice(a + b, a + b + c),
    u8.slice(a + b + c)
  ];
}

function makeDecoyBlob(len) {
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = rnd(0, 256);
  return toLuaEscaped(arr);
}

function obfuscate(source, options) {
  options = options || {};
  const layers = options.layers || 3;
  const doSplit = options.split !== false;
  const doDecoy = options.decoy !== false;
  const doMinify = options.minify !== false;
  const doAntiDump = options.antiDump !== false;
  const doStringEnc = options.stringEnc !== false;
  const doConstantEnc = options.constantEnc !== false;
  const doAntiTamper = options.antiTamper !== false;
  const doMacro = options.macro !== false;
  const doNoise = options.controlNoise !== false;
  const doWatermark = options.watermark !== false;
  const shred = options.shred !== false;
  const integrity = options.integrity !== false;
  const splitVM = options.splitVM !== false;

  let code = String(source);
  let strTable = [];
  if (doStringEnc) {
    const r = encryptAllStrings(code);
    code = r.code;
    strTable = r.table;
  }
  if (doConstantEnc) {
    code = code.replace(/\b(\d{2,})\b/g, function (m) {
      const n = Number(m);
      if (n > 10 && n < 1e9) return obfuscateNumber(n);
      return m;
    });
  }

  const seed = (Math.random() * 0x7fffffff) | 0;
  const packed = multiPack(code, seed, layers);

  let pA, pB, pC, pD;
  if (doSplit) {
    const parts = split4(packed);
    pA = toLuaEscaped(parts[0]);
    pB = toLuaEscaped(parts[1]);
    pC = toLuaEscaped(parts[2]);
    pD = toLuaEscaped(parts[3]);
  } else {
    pA = toLuaEscaped(packed);
    pB = pC = pD = "";
  }

  const decoy1 = doDecoy ? makeDecoyBlob(rnd(80, 220)) : "";
  const decoy2 = doDecoy ? makeDecoyBlob(rnd(60, 180)) : "";
  const decoy3 = doDecoy ? makeDecoyBlob(rnd(40, 140)) : "";

  const srcBytes = utf8Encode(code);
  const srcSum = adler32(srcBytes);
  const srcRoll = rollHash(srcBytes);
  const srcLen = srcBytes.length;

  const antiTamper = doAntiTamper ? `
local M=268435456
local function LA(v,w)v=(772109*v+99839573)%M;v=(943141*v+53826001)%M;v=(28527*v+190023955)%M;local E=542449*v+158955153;v=E%M;v=(470721*v+22251399)%M;v=(505333*v+73248309)%M;w=(w+27317064)%M;E=837995*v;v=(E+232349809)%M;v=(636017*v+93260283)%M;v=(317931*v+43492595)%M;v=(512699*v+47534657)%M;return v,w end
local function LB(v,w)v=v-v%2+1;w=(1000009*w+228639731)%M;w=(108657*w+159828783)%M;return v,w end
local function LC(w,E)w=w-w%2+1;E=(101615*E+188904345)%M;E=(499379*E+86154911)%M;return true,w,E end
local function LD(w,E)w=w-w%2+1;E=(143411*E+165109863)%M;E=(734979*E+202578441)%M;return true,w,E end
local function isN(f)if typeof and typeof(f)~="function"then return false end;if debug and debug.getinfo then local i=debug.getinfo(f);if i and i.what=="Lua"then return false end end;if is_cclosure then return is_cclosure(f)end;return true end
local NList={bit32 and bit32.band,bit32 and bit32.bxor,bit32 and bit32.rshift,bit32 and bit32.lshift,bit32 and bit32.bor,buffer and buffer.readu8,buffer and buffer.create,string.byte,string.char,string.sub,string.gsub,string.rep,table.insert,table.concat,pcall,xpcall,type,typeof,rawget,rawset,rawequal,select,pairs,ipairs,next,setmetatable,getmetatable,error,assert,loadstring,coroutine.create,coroutine.resume,coroutine.yield,coroutine.wrap}
local function checkHooks()for i=1,#NList do if NList[i]and not isN(NList[i])then return false end end;return true end
local function checkId()local t={bit32 and bit32.band,rawget,pcall,buffer and buffer.readu8,typeof,rawequal};for i=1,#t do if t[i]and not rawequal(t[i],t[i])then return false end end;return true end
local function checkEnv()if typeof then if typeof(workspace)~="Instance"or typeof(game)~="DataModel"then return false end end;return true end
local function hasHook()return hookfunction~=nil or hookmetamethod~=nil end
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
local _K=((s1~s3~s5)+${seed & 0xff})%256
local _K2=((s2~s4~s6)*13+${(seed >>> 8) & 0xff})%256
local _K3=((s1+s6)*7+${(seed >>> 16) & 0xff})%256
` : `local function crash()while true do end end;local _K=${seed & 0xff};local _K2=${(seed >>> 8) & 0xff};local _K3=${(seed >>> 16) & 0xff}`;

  const macro = doMacro ? `
local _MX={}
_MX[1]=function()return checkHooks and checkHooks()or true end
_MX[2]=function()return checkId and checkId()or true end
_MX[3]=function()return _K~=nil and _K2~=nil end
local function runMX()for _,f in pairs(_MX)do local ok,r=pcall(f);if not ok or r==false then return false end end;return true end
if not runMX()then crash()end
` : "";

  const strDec = doStringEnc ? `
local _ST=${JSON.stringify(strTable).replace(/"/g, '\\"')}
local function _S(id)local e=_ST[id+1];if not e then return""end;local k1,k2,k3,d=e[1],e[2],e[3],e[4];local t={};for i=1,#d do local c=d[i];c=c~(k3+(i-1)*3)%233;c=c~(k2+(i-1)*7)%241;c=c~(k1+(i-1)*13)%251;t[i]=string.char(c)end;return table.concat(t)end
` : "";

  const noise = doNoise ? `
local _n=0;for _i=1,9 do _n=_n+(_i*7)%13 end;if _n<0 or _n>200 then crash()end
local _op=(_K+_K2+_K3)%3
if _op==2 and _K>400 then crash()end
` : "";

  let vmParts = "";
  if (splitVM) {
    vmParts = `
local function _vh(r)
if not r or #r<14 then return nil end
if r:byte(1)~=82 or r:byte(2)~=78 or r:byte(3)~=89 then return nil end
return r:byte(5),r:byte(6),r:byte(7)
end
local function _vx(r,k1,k2,k3,key)
k1=(k1+key)%256;k2=(k2+(key*3))%256;k3=(k3+(key*7))%256
local body={}
for i=15,#r do
local v=r:byte(i)
v=v~(k3+((i-15)*3))&255
v=v~(k2+((i-15)*7))&255
v=v~(k1+((i-15)*13))&255
body[#body+1]=string.char(v)
end
return table.concat(body)
end
local function _vl(body)
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
local function _unpack(r,key)
local k1,k2,k3=_vh(r)
if not k1 then return nil end
local body=_vx(r,k1,k2,k3,key)
if not body then return nil end
return _vl(body)
end
`;
  } else {
    vmParts = `
local function _unpack(r,key)
if not r or #r<14 then return nil end
if r:byte(1)~=82 or r:byte(2)~=78 or r:byte(3)~=89 then return nil end
local k1,k2,k3=r:byte(5),r:byte(6),r:byte(7)
k1=(k1+key)%256;k2=(k2+(key*3))%256;k3=(k3+(key*7))%256
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
`;
  }

  const decoyFns = doDecoy ? `
local function _dx(r,k)
local k1,k2,k3=r:byte(5)or 0,r:byte(6)or 0,r:byte(7)or 0
k1=(k1+k*5)%256;k2=(k2+k*11)%256;k3=(k3+k*19)%256
local t={}
for i=15,#r do
local v=r:byte(i)
v=v~(k3+((i-15)*9))&255
v=v~(k2+((i-15)*5))&255
v=v~(k1+((i-15)*17))&255
t[#t+1]=string.char(v)
end
return table.concat(t)
end
local function _dy(r)
local t={}
for i=1,#r do t[i]=string.char((r:byte(i)*3+17)%256)end
return table.concat(t)
end
local function _dz(r,k)
local t={}
for i=1,#r do t[i]=string.char((r:byte(i)~(k+(i%13)))&255)end
return table.concat(t)
end
` : "";

  let body = "";
  if (doSplit) {
    body += `
local _A="${pA}"
local _B="${pB}"
local _C="${pC}"
local _D="${pD}"
${doDecoy ? `local _FA="${decoy1}"\nlocal _FB="${decoy2}"\nlocal _FC="${decoy3}"` : ""}
${vmParts}
${decoyFns}
${doDecoy ? `
local _junk1=_dx(_FA,_K3)
local _junk2=_dy(_FB)
local _junk3=_dz(_FC,_K)
_FA,_FB,_FC=nil,nil,nil
` : ""}
local _raw=_A.._B
_A,_B=nil,nil
_raw=_raw.._C
_C=nil
_raw=_raw.._D
_D=nil
local src=_unpack(_raw,_K)
_raw=nil
if not src then crash()end
for _=1,${layers - 1} do
src=_unpack(src,_K2)
if not src then crash()end
end
_K,_K2,_K3=0,0,0
`;
  } else {
    body += `
local _P="${pA}"
${vmParts}
${decoyFns}
local src=_unpack(_P,_K)
_P=nil
if not src then crash()end
for _=1,${layers - 1} do
src=_unpack(src,_K2)
if not src then crash()end
end
_K,_K2,_K3=0,0,0
`;
  }

  if (doStringEnc) {
    body += `src=src:gsub("_S%((%d+)%)",function(i)return _S(tonumber(i))end)\n`;
  }

  if (integrity) {
    body += `
local function _adler(s)
local a,b=1,0
for i=1,#s do a=(a+s:byte(i))%65521;b=(b+a)%65521 end
return ((b*65536)+a)%4294967296
end
local function _roll(s)
local h=2166136261
for i=1,#s do h=bit32 and bit32.bxor(h,s:byte(i))or(h~s:byte(i));h=(h*16777619)%4294967296 end
return h%4294967296
end
if #src~=${srcLen} then crash()end
if _adler(src)~=${srcSum} then crash()end
if _roll(src)~=${srcRoll} then crash()end
`;
  } else {
    body += `
local function _chk(s)
local a,b=1,0
for i=1,#s do a=(a+s:byte(i))%65521;b=(b+a)%65521 end
return ((b*65536)+a)%4294967296
end
if _chk(src)~=${srcSum} then crash()end
`;
  }

  if (shred) {
    body += `
local function _shred(s)
local n=#s
if n<32 then return s end
local p1=s:sub(1,math.floor(n/4))
local p2=s:sub(math.floor(n/4)+1,math.floor(n/2))
local p3=s:sub(math.floor(n/2)+1,math.floor(n*3/4))
local p4=s:sub(math.floor(n*3/4)+1)
s=nil
local t=p1..p2
p1,p2=nil,nil
t=t..p3
p3=nil
t=t..p4
p4=nil
return t
end
src=_shred(src)
`;
  }

  body += `
local fn=loadstring(src)
src=string.rep("\\0",#src)
src=nil
if not fn then crash()end
${doDecoy ? `_junk1,_junk2,_junk3=nil,nil,nil` : ""}
return fn()
`;

  let final = `return(function()${antiTamper}${macro}${strDec}${noise}${body}end)()`;

  if (doAntiDump) {
    final = final
      .replace(/loadstring/g, "load" + "string")
      .replace(/string\.char/g, "string['\\99\\104\\97\\114']")
      .replace(/string\.byte/g, "string['\\98\\121\\116\\101']")
      .replace(/string\.sub/g, "string['\\115\\117\\98']")
      .replace(/string\.gsub/g, "string['\\103\\115\\117\\98']")
      .replace(/string\.rep/g, "string['\\114\\101\\112']")
      .replace(/table\.concat/g, "table['\\99\\111\\110\\99\\97\\116']")
      .replace(/getinfo/g, "get" + "info")
      .replace(/is_cclosure/g, "is_" + "cclosure")
      .replace(/hookfunction/g, "hook" + "function")
      .replace(/hookmetamethod/g, "hook" + "metamethod")
      .replace(/rawequal/g, "raw" + "equal")
      .replace(/typeof/g, "type" + "of")
      .replace(/getrawmetatable/g, "get" + "rawmetatable");
  }

  if (doMinify) {
    final = final
      .replace(/--[^\n]*/g, "")
      .replace(/\s+/g, " ")
      .replace(/ ?([{}()\[\],;=<>~+\-*/%|&!]) ?/g, "$1")
      .replace(/;+/g, ";")
      .replace(/ ?([{}()\[\],;=<>~+\-*/%|&!]) ?/g, "$1")
      .trim();
  }

  if (doWatermark) {
    final = `--[[RNYv5]]` + final;
  }

  return final;
}

/* ========== WEB UI ========== */
const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>리트냥이 v5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#0f0f13;color:#e4e4e7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:32px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:1.5rem;margin-bottom:4px;background:linear-gradient(135deg,#a78bfa,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#71717a;font-size:.85rem;margin-bottom:24px}
.drop{border:2px dashed #3f3f46;border-radius:12px;padding:36px 20px;text-align:center;cursor:pointer;transition:.2s;margin-bottom:16px}
.drop:hover,.drop.drag{border-color:#a78bfa;background:#1e1b2e}
.drop p{color:#a1a1aa;font-size:.9rem}
.drop strong{color:#e4e4e7}
input[type=file]{display:none}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;font-size:.8rem;color:#a1a1aa}
.opts label{display:flex;align-items:center;gap:6px;cursor:pointer}
button{width:100%;padding:14px;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;transition:.2s}
button:hover{opacity:.9;transform:translateY(-1px)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
.status{margin-top:16px;font-size:.85rem;color:#a1a1aa;min-height:1.2em}
.status.ok{color:#4ade80}
.status.err{color:#f87171}
.file-name{margin-top:8px;font-size:.8rem;color:#c4b5fd}
</style>
</head>
<body>
<div class="card">
<h1>리트냥이 v5</h1>
<p class="sub">파일 올리고 난독화 누르면 바로 다운로드</p>
<div class="drop" id="drop">
<p><strong>클릭</strong> 또는 파일을 여기로 드래그</p>
<p class="file-name" id="fname"></p>
</div>
<input type="file" id="file" accept=".lua,.txt,.luau">
<div class="opts">
<label><input type="checkbox" id="layers3" checked> 3중 레이어</label>
<label><input type="checkbox" id="split" checked> 페이로드 분할</label>
<label><input type="checkbox" id="decoy" checked> 데코이</label>
<label><input type="checkbox" id="integrity" checked> 무결성 검사</label>
<label><input type="checkbox" id="splitVM" checked> VM 쪼개기</label>
<label><input type="checkbox" id="shred" checked> 소스 shred</label>
</div>
<button id="btn">난독화 & 다운로드</button>
<div class="status" id="status"></div>
</div>
<script>
const drop=document.getElementById('drop');
const fileInput=document.getElementById('file');
const fname=document.getElementById('fname');
const btn=document.getElementById('btn');
const status=document.getElementById('status');
let selected=null;
drop.onclick=()=>fileInput.click();
drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')};
drop.ondragleave=()=>drop.classList.remove('drag');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])};
fileInput.onchange=()=>{if(fileInput.files[0])setFile(fileInput.files[0])};
function setFile(f){selected=f;fname.textContent=f.name+' ('+(f.size/1024).toFixed(1)+' KB)';status.textContent=''}
btn.onclick=async()=>{
if(!selected){status.className='status err';status.textContent='파일을 선택하세요';return}
btn.disabled=true;status.className='status';status.textContent='난독화 중...';
const fd=new FormData();
fd.append('file',selected);
fd.append('layers',document.getElementById('layers3').checked?'3':'2');
fd.append('split',document.getElementById('split').checked?'1':'0');
fd.append('decoy',document.getElementById('decoy').checked?'1':'0');
fd.append('integrity',document.getElementById('integrity').checked?'1':'0');
fd.append('splitVM',document.getElementById('splitVM').checked?'1':'0');
fd.append('shred',document.getElementById('shred').checked?'1':'0');
try{
const res=await fetch('/obfuscate',{method:'POST',body:fd});
if(!res.ok){const err=await res.json().catch(()=>({}));throw new Error(err.error||res.statusText)}
const blob=await res.blob();
const url=URL.createObjectURL(blob);
const a=document.createElement('a');
a.href=url;a.download=selected.name.replace(/\\.[^.]+$/,'')+'_obfuscated.lua';a.click();
URL.revokeObjectURL(url);
status.className='status ok';status.textContent='완료! 다운로드 시작됨';
}catch(e){status.className='status err';status.textContent='실패: '+e.message}
finally{btn.disabled=false}
};
</script>
</body>
</html>`;

function parseMultipart(buf, boundary) {
  const result = { fields: {}, file: null };
  const parts = buf.toString("binary").split("--" + boundary);
  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    let body = part.slice(headerEnd + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const nameMatch = header.match(/name="([^"]+)"/);
    const fileMatch = header.match(/filename="([^"]+)"/);
    if (fileMatch && nameMatch) {
      result.file = { name: fileMatch[1], data: Buffer.from(body, "binary").toString("utf8") };
    } else if (nameMatch) {
      result.fields[nameMatch[1]] = body.trim();
    }
  }
  return result;
}

const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const send = (status, data, headers) => {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    res.writeHead(status, Object.assign({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }, headers || {}));
    res.end(body);
  };

  if (req.method === "OPTIONS") return send(204, "");

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return send(200, HTML, { "Content-Type": "text/html; charset=utf-8" });
  }

  if (req.method === "POST" && req.url === "/obfuscate") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      let code = "";
      const opts = {
        layers: 3, split: true, decoy: true, shred: true,
        integrity: true, splitVM: true, minify: true,
        antiTamper: true, antiDump: true, stringEnc: true,
        constantEnc: true, macro: true, controlNoise: true, watermark: true
      };

      if (ct.includes("multipart/form-data")) {
        const boundary = ct.split("boundary=")[1];
        if (!boundary) return send(400, { error: "no boundary" }, { "Content-Type": "application/json" });
        const parsed = parseMultipart(buf, boundary);
        if (!parsed.file || !parsed.file.data) return send(400, { error: "file required" }, { "Content-Type": "application/json" });
        code = parsed.file.data;
        if (parsed.fields.layers) opts.layers = parseInt(parsed.fields.layers, 10) || 3;
        if (parsed.fields.split === "0") opts.split = false;
        if (parsed.fields.decoy === "0") opts.decoy = false;
        if (parsed.fields.integrity === "0") opts.integrity = false;
        if (parsed.fields.splitVM === "0") opts.splitVM = false;
        if (parsed.fields.shred === "0") opts.shred = false;
      } else {
        code = buf.toString("utf8");
      }

      if (!code || code.length < 1) return send(400, { error: "empty" }, { "Content-Type": "application/json" });
      if (code.length > 3000000) return send(413, { error: "too large" }, { "Content-Type": "application/json" });

      const result = obfuscate(code, opts);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="obfuscated.lua"',
        "Access-Control-Allow-Origin": "*"
      });
      res.end(result);
    } catch (e) {
      console.error(e);
      send(500, { error: String(e.message || e) }, { "Content-Type": "application/json" });
    }
    return;
  }

  send(404, "not found");
});

server.listen(PORT, () => {
  console.log("[리트냥이 v5] http://localhost:" + PORT);
});
