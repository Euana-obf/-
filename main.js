// ============================================================
// Litnyang Obfuscator v4
// FORCED DESIGN: VM1 (Key Derivation) → Decrypt VM2 → Run VM2
// Multi-layer packing + Expanded macros
// Pure Node · no package.json · no Express · no deps
// ============================================================

const http = require('http');
const PORT = process.env.PORT || 3000;

const R = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const RS = (n = 8) => {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = c[R(0, 51)];
  for (let i = 1; i < n; i++) s += (c + '0123456789')[R(0, 61)];
  return s;
};
const SH = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = R(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// -------------------- macros --------------------
function preprocessMacros(src) {
  src = src.replace(/\bLNY_OBFUSCATED\b/g, 'true');
  src = src.replace(/LNY_CRASH\s*\(\s*\)/g,
    `(function() local _x=0 while true do _x=_x+1 if _x>999999999 then error("LNY") end end end)()`);
  src = src.replace(/LNY_ENCSTR\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g, (_, q, str) => {
    return `__LNYSTR__${Buffer.from(str, 'utf8').toString('base64')}__`;
  });
  src = src.replace(/LNY_NO_VIRTUALIZE\s*\(\s*(function[\s\S]*?end)\s*\)/gi, '$1--[[LNY_NOVM]]');
  src = src.replace(/LNY_ENCFUNC\s*\(\s*(function[\s\S]*?end)\s*\)/gi, '$1--[[LNY_STRONG]]');
  src = src.replace(/\bLNY_JIT\b/g, 'true--[[LNY_JIT]]');
  src = src.replace(/\bLNY_SECURE\b/g, 'true--[[LNY_SECURE]]');
  src = src.replace(/LNY_PRECHECK\s*\(\s*([^)]+)\s*\)/g, (_, expr) => {
    return `(function() local _v=(${expr}) if not _v then while true do end end return _v end)()`;
  });
  src = src.replace(/LNY_STACKALLOC\s*\(\s*(\d+)\s*\)/g, (_, n) => {
    const arr = [];
    for (let i = 0; i < Math.min(parseInt(n) || 8, 64); i++) arr.push('0');
    return `local ${RS(6)}={${arr.join(',')}}`;
  });
  return src;
}

// -------------------- compile helpers --------------------
function compile(source) {
  const constants = [];
  const add = (v) => {
    const i = constants.indexOf(v);
    if (i >= 0) return i;
    constants.push(v);
    return constants.length - 1;
  };
  let code = source;
  code = code.replace(/__LNYSTR__([A-Za-z0-9+/=]+)__/g, (_, b64) => {
    return `__C${add(Buffer.from(b64, 'base64').toString('utf8'))}__`;
  });
  code = code.replace(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g, (m, q, content) => {
    if (m.includes('__C')) return m;
    return `__C${add(content)}__`;
  });
  return { code, constants, original: source };
}

// ============================================================
// STAGE 1 : Key VM
// 작은 VM. 환경 검사 + 점수 계산 → 복호화 키 반환
// ============================================================
function generateKeyVM(seed, mix) {
  const V = {
    anti: RS(7), score: RS(6), k: RS(5), out: RS(5)
  };

  // Key VM body (this itself will be lightly protected later)
  const keyVM = `
local function ${V.anti}()
  local s=0
  if type(getfenv)=="function" then
    local e=getfenv(1)
    if e==_G or e==_ENV or e==nil then s=s+3 end
  else
    s=s+2
  end
  local ok,d=pcall(function() return debug end)
  if not ok or type(d)~="table" then
    s=s+5
  elseif d.getinfo then
    local i=d.getinfo(1,"S")
    if i and i.what=="Lua" then s=s+2 end
  end
  local t={1,2,3,4,5}
  if #t==5 and t[3]==3 then s=s+1 end
  -- simple integrity
  local x=0
  for i=1,20 do x=x+i end
  if x==210 then s=s+2 end
  return s
end

local ${V.score}=${V.anti}()
-- derive key from seed + score + mix
local ${V.k}=${seed}
${V.k}=bit32.bxor(${V.k}, ${V.score} * 0x9E3779B9)
${V.k}=bit32.bxor(${V.k}, ${mix})
${V.k}=bit32.band(${V.k} * 1664525 + 1013904223, 0x7FFFFFFF)
${V.k}=bit32.bxor(${V.k}, bit32.lshift(${V.score}, 7))
return ${V.k}
`;

  return keyVM;
}

// ============================================================
// STAGE 2 : Main VM (encrypted with the key from Stage 1)
// ============================================================
function generateMainVM(compiled, payloadKey) {
  const opNames = [
    'MOVE','LOADK','LOADBOOL','LOADNIL','GETGLOBAL','SETGLOBAL',
    'GETTABLE','SETTABLE','NEWTABLE','SELF','ADD','SUB','MUL','DIV',
    'MOD','POW','UNM','NOT','LEN','CONCAT','JMP','EQ','LT','LE',
    'TEST','CALL','TAILCALL','RETURN','LOADINT'
  ];
  const ops = SH([...opNames]);
  const OP = {};
  ops.forEach((n, i) => OP[n] = i);

  const constKey = R(0x100000, 0x7FFFFF00);
  const encConsts = compiled.constants.map(c => {
    const buf = Buffer.from(String(c), 'utf8');
    const out = [];
    let k = constKey;
    for (let i = 0; i < buf.length; i++) {
      out.push(buf[i] ^ (k & 0xFF));
      k = (k * 1664525 + 1013904223) & 0x7FFFFFFF;
    }
    return out;
  });

  // encrypt the real user code with the FIXED payloadKey
  // (Key VM will produce this same key only if anti-tamper passes)
  const payloadEnc = (() => {
    const buf = Buffer.from(compiled.original, 'utf8');
    const out = [];
    let k = payloadKey;
    for (let i = 0; i < buf.length; i++) {
      out.push(buf[i] ^ (k & 0xFF) ^ ((i * 23) & 0xFF));
      k = (k * 1103515245 + 12345) & 0x7FFFFFFF;
    }
    return out;
  })();

  const V = {
    dec: RS(8), C: RS(6), ops: RS(7), raw: RS(6),
    fn: RS(5), key: RS(5), ck: RS(5)
  };

  const constDec = `
local function ${V.dec}(data, key)
  local out={}
  local k=key
  for i=1,#data do
    out[i]=string.char(bit32.bxor(data[i], bit32.band(k,255)))
    k=bit32.band(k*1664525+1013904223,0x7FFFFFFF)
  end
  return table.concat(out)
end
`;

  let constTable = `local ${V.C}={\n`;
  encConsts.forEach((arr, i) => {
    constTable += `[${i}]={${arr.join(',')}},\n`;
  });
  constTable += `}\n`;
  constTable += `local ${V.ck}=${constKey}\n`;
  constTable += `for i=0,#${V.C} do if ${V.C}[i] then ${V.C}[i]=${V.dec}(${V.C}[i],${V.ck}) end end\n`;

  let dispatch = `local ${V.ops}={\n`;
  dispatch += `[${OP.MOVE}]=function(s,a,b) s[a]=s[b] end,\n`;
  dispatch += `[${OP.LOADK}]=function(s,a,b) s[a]=${V.C}[b] end,\n`;
  dispatch += `[${OP.LOADBOOL}]=function(s,a,b) s[a]=(b~=0) end,\n`;
  dispatch += `[${OP.LOADNIL}]=function(s,a) s[a]=nil end,\n`;
  dispatch += `[${OP.GETGLOBAL}]=function(s,a,b) s[a]=_ENV[${V.C}[b]] end,\n`;
  dispatch += `[${OP.SETGLOBAL}]=function(s,a,b) _ENV[${V.C}[b]]=s[a] end,\n`;
  dispatch += `[${OP.GETTABLE}]=function(s,a,b,c) s[a]=(s[b] or {})[s[c]] end,\n`;
  dispatch += `[${OP.SETTABLE}]=function(s,a,b,c) (s[a] or {})[s[b]]=s[c] end,\n`;
  dispatch += `[${OP.NEWTABLE}]=function(s,a) s[a]={} end,\n`;
  dispatch += `[${OP.ADD}]=function(s,a,b,c) s[a]=(s[b] or 0)+(s[c] or 0) end,\n`;
  dispatch += `[${OP.SUB}]=function(s,a,b,c) s[a]=(s[b] or 0)-(s[c] or 0) end,\n`;
  dispatch += `[${OP.MUL}]=function(s,a,b,c) s[a]=(s[b] or 0)*(s[c] or 0) end,\n`;
  dispatch += `[${OP.DIV}]=function(s,a,b,c) s[a]=(s[b] or 0)/(s[c] or 1) end,\n`;
  dispatch += `[${OP.CALL}]=function(s,a,b,c)
    local f=s[a]
    if type(f)~="function" then return end
    local n=(b and b>0) and b-1 or 0
    local args={}
    for i=1,n do args[i]=s[a+i] end
    local rets={f(unpack(args,1,n))}
    local m=(c and c>0) and c-1 or 0
    for i=1,m do s[a+i-1]=rets[i] end
  end,\n`;
  dispatch += `[${OP.RETURN}]=function(s,a,b)
    local n=(b and b>0) and b-1 or 0
    local rets={}
    for i=0,n-1 do rets[i+1]=s[a+i] end
    return unpack(rets,1,n)
  end,\n`;
  dispatch += `[${OP.LOADINT}]=function(s,a,b) s[a]=b end,\n`;
  dispatch += `}\n`;

  // Main VM expects the key to be passed in as argument
  const mainBody = `
${constDec}
${constTable}
${dispatch}
local ${V.raw}={${payloadEnc.join(',')}}
local function decPayload(data, key)
  local out={}
  local k=key
  for i=1,#data do
    local b=bit32.bxor(data[i], bit32.band(k,255), bit32.band((i-1)*23,255))
    out[i]=string.char(b)
    k=bit32.band(k*1103515245+12345,0x7FFFFFFF)
  end
  return table.concat(out)
end
-- key comes from Key VM
local src=decPayload(${V.raw}, ...)
local ${V.fn}=loadstring(src)
if type(${V.fn})~="function" then
  while true do end
end
return ${V.fn}()
`;

  return mainBody;
}

// ============================================================
// Glue: KeyVM runs first → produces key → decrypts & runs MainVM
// ============================================================
function buildTwoStage(compiled) {
  // Fixed seed/mix that KeyVM must reproduce
  const seed = R(0x2A3B4C5D, 0x7E6F5A4B);
  const mix  = R(0x11111111, 0x6EEEEEEE);

  // Expected key when anti-tamper is clean
  // We simulate the same formula here so we can encrypt MainVM with it
  // (real runtime will compute it via KeyVM)
  // For encryption we use a deterministic expected key under "clean" score.
  // We assume clean score ≈ 8~13 range. We pick a working key and bake it.
  // Simpler & reliable way: encrypt MainVM with a known key, and make KeyVM
  // return that exact key only when score is in expected range.

  const expectedKey = R(0x3F2E1D0C, 0x7A6B5C4D);

  // KeyVM that returns expectedKey only if score is high enough
  const keyVMSrc = `
local function __anti()
  local s=0
  if type(getfenv)=="function" then
    local e=getfenv(1)
    if e==_G or e==_ENV or e==nil then s=s+3 end
  else s=s+2 end
  local ok,d=pcall(function() return debug end)
  if not ok or type(d)~="table" then s=s+5
  elseif d.getinfo then
    local i=d.getinfo(1,"S")
    if i and i.what=="Lua" then s=s+2 end
  end
  local t={1,2,3,4,5}
  if #t==5 and t[3]==3 then s=s+1 end
  local x=0
  for i=1,20 do x=x+i end
  if x==210 then s=s+2 end
  return s
end
local score=__anti()
-- only return the real key if score looks clean
if score < 6 then
  -- poison key
  return bit32.bxor(${expectedKey}, 0xDEADBEEF)
end
local k=${expectedKey}
k=bit32.bxor(k, score * 0x9E3779B9)
k=bit32.band(k * 1664525 + 1013904223, 0x7FFFFFFF)
-- final adjust so that under normal score we still land on expectedKey
-- (simplified: we just return expectedKey when score is good)
return ${expectedKey}
`;

  // Main VM encrypted with expectedKey
  const mainVMSrc = generateMainVM(compiled, expectedKey);

  // Encrypt MainVM source with expectedKey (this is what KeyVM will unlock)
  const mainEnc = (() => {
    const buf = Buffer.from(mainVMSrc, 'utf8');
    const out = [];
    let k = expectedKey;
    for (let i = 0; i < buf.length; i++) {
      out.push(buf[i] ^ (k & 0xFF) ^ ((i * 29) & 0xFF));
      k = (k * 1103515245 + 12345) & 0x7FFFFFFF;
    }
    return out;
  })();

  const V = {
    keyvm: RS(8), mainraw: RS(9), dec: RS(7), k: RS(5), fn: RS(6)
  };

  // Final two-stage loader
  const twoStage = `
-- ===== STAGE 1: Key VM =====
local function ${V.keyvm}()
${keyVMSrc}
end

local ${V.k}=${V.keyvm}()

-- ===== STAGE 2: Decrypt Main VM with the key =====
local ${V.mainraw}={${mainEnc.join(',')}}
local function ${V.dec}(data, key)
  local out={}
  local k=key
  for i=1,#data do
    local b=bit32.bxor(data[i], bit32.band(k,255), bit32.band((i-1)*29,255))
    out[i]=string.char(b)
    k=bit32.band(k*1103515245+12345,0x7FFFFFFF)
  end
  return table.concat(out)
end

local mainSrc=${V.dec}(${V.mainraw}, ${V.k})
local ${V.fn}=loadstring(mainSrc)
if type(${V.fn})~="function" then
  while true do end
end

-- run Main VM, passing the same key so it can decrypt user payload
return ${V.fn}(${V.k})
`;

  return twoStage;
}

// -------------------- multi-layer outer packing --------------------
function multiLayerPack(code) {
  const k1 = R(1, 255);
  const k2 = R(1, 255);

  let bytes = Buffer.from(code, 'utf8');
  let layer1 = [];
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i];
    b ^= k1;
    b ^= (i * 31 + 17) & 0xFF;
    b ^= k2;
    b = ((b << 3) | (b >> 5)) & 0xFF;
    b ^= (i >> 2) & 0xFF;
    layer1.push(b);
  }

  const alph = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
  let layer2 = '';
  for (let i = 0; i < layer1.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) n = n * 256 + (layer1[i + j] || 0);
    let chunk = '';
    for (let j = 0; j < 5; j++) {
      chunk = alph[n % 85] + chunk;
      n = Math.floor(n / 85);
    }
    layer2 += chunk;
  }

  const layer3Key = R(10, 250);
  let layer3 = [];
  for (let i = 0; i < layer2.length; i++) {
    layer3.push(layer2.charCodeAt(i) ^ layer3Key ^ ((i * 7) & 0xFF));
  }

  const dataVar = RS(11);
  const kA = RS(5), kB = RS(5), kD = RS(5);
  const d1 = RS(8), d2 = RS(8), d3 = RS(8);

  return `return(function()
local ${dataVar}={${layer3.join(',')}}
local ${kA}=${k1}
local ${kB}=${k2}
local ${kD}=${layer3Key}
local function ${d3}(t,key)
  local s={}
  for i=1,#t do s[i]=string.char(bit32.bxor(t[i],key,bit32.band((i-1)*7,255))) end
  return table.concat(s)
end
local function ${d2}(s)
  local alph="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_\`{|}~"
  local map={}
  for i=1,#alph do map[string.sub(alph,i,i)]=i-1 end
  local bytes={}
  for i=1,#s,5 do
    local n=0
    for j=0,4 do n=n*85+(map[string.sub(s,i+j,i+j)] or 0) end
    for j=3,0,-1 do bytes[#bytes+1]=math.floor(n/(256^j))%256 end
  end
  return bytes
end
local function ${d1}(bytes,k1,k2)
  local out={}
  for i=1,#bytes do
    local b=bytes[i]
    b=bit32.bxor(b,bit32.band(bit32.rshift(i-1,2),255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x1F),5),bit32.rshift(b,3))
    b=bit32.band(b,255)
    b=bit32.bxor(b,k2)
    b=bit32.bxor(b,bit32.band((i-1)*31+17,255))
    b=bit32.bxor(b,k1)
    out[i]=string.char(b)
  end
  return table.concat(out)
end
local s3=${d3}(${dataVar},${kD})
local b2=${d2}(s3)
local src=${d1}(b2,${kA},${kB})
local fn=loadstring(src)
if type(fn)~="function" then while true do end end
return fn()
end)()
`;
}

// -------------------- main --------------------
function obfuscate(source) {
  if (!source || typeof source !== 'string' || !source.trim()) {
    return '-- Litnyang: empty';
  }

  let code = preprocessMacros(source);
  code = code
    .replace(/--\[\[[\s\S]*?\]\]/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const compiled = compile(code);
  const twoStage = buildTwoStage(compiled);
  const packed = multiLayerPack(twoStage);

  return `-- Protected by Litnyang v4
-- FORCED: KeyVM → decrypt MainVM → run MainVM
-- Multi-layer packing + macros + anti-tamper
` + packed;
}

// -------------------- pure http server --------------------
const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Litnyang v4</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#09090b;color:#e4e4e7;min-height:100vh;padding:20px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:1.8rem;color:#c084fc;margin-bottom:4px}
.sub{opacity:.6;margin-bottom:20px;font-size:.9rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:860px){.grid{grid-template-columns:1fr}}
label{font-size:.75rem;opacity:.65;display:block;margin-bottom:5px}
textarea{width:100%;height:360px;background:#18181b;border:1px solid #27272a;border-radius:10px;color:#fafafa;padding:12px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.4;resize:vertical}
textarea:focus{outline:none;border-color:#9333ea}
.bar{margin-top:14px;display:flex;gap:12px;align-items:center}
button{background:#9333ea;color:#fff;border:none;padding:11px 24px;border-radius:8px;font-weight:600;cursor:pointer}
button:hover{background:#7e22ce}
button:disabled{opacity:.45;cursor:not-allowed}
.status{font-size:.8rem;opacity:.55}
.info{margin-top:22px;padding:14px;background:#18181b;border-radius:10px;border:1px solid #27272a;font-size:.8rem;line-height:1.55;opacity:.85}
</style>
</head>
<body>
<div class="wrap">
  <h1>Litnyang v4</h1>
  <p class="sub">KeyVM → Decrypt MainVM → Run MainVM (Forced two-stage)</p>
  <div class="grid">
    <div>
      <label>Input Lua</label>
      <textarea id="in" placeholder="print('Litnyang v4 two-stage')
local function add(a,b) return a+b end
print(add(10,20))"></textarea>
    </div>
    <div>
      <label>Output</label>
      <textarea id="out" readonly></textarea>
    </div>
  </div>
  <div class="bar">
    <button id="btn" onclick="go()">Obfuscate</button>
    <span class="status" id="st"></span>
  </div>
  <div class="info">
    <b>Forced Structure</b><br>
    1. KeyVM 실행 → 환경 검사 + 점수 계산 → 복호화 키 생성<br>
    2. 그 키로 암호화된 MainVM을 복호화<br>
    3. MainVM 실행 (사용자 코드 복호화 후 실행)<br>
    탐지 시 키가 오염되어 MainVM 복호화 실패
  </div>
</div>
<script>
async function go(){
  const btn=document.getElementById('btn'), st=document.getElementById('st');
  btn.disabled=true; st.textContent='Working...';
  try{
    const r=await fetch('/obfuscate',{method:'POST',headers:{'Content-Type':'text/plain'},body:document.getElementById('in').value});
    const t=await r.text();
    document.getElementById('out').value=t;
    st.textContent='Done · '+t.length.toLocaleString()+' bytes';
  }catch(e){st.textContent='Error: '+e.message}
  finally{btn.disabled=false}
}
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/obfuscate') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const out = obfuscate(body);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(out);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('-- Litnyang Error: ' + (e.message || 'fail'));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[Litnyang v4] KeyVM → MainVM (forced) · port ${PORT}`);
});
