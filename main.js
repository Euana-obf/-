// ============================================================
// Litnyang Obfuscator v6.4
// Nested VM + Threaded XOR handlers (VMProtect-style) + Lazy const
// Anti-dump/jail + LNY_/LTY_ macros + Minify + MT traps
// Pure Node · no deps
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

// ============================================================
// MACRO ENGINE (LNY_ / LTY_ 동일 취급 · Litnyang)
// ============================================================
function preprocessMacros(src) {
  // normalize LTY_ → LNY_ so both work
  src = src.replace(/\bLTY_/g, 'LNY_');

  // --- flags ---
  src = src.replace(/\bLNY_OBFUSCATED\b/g, 'true');
  src = src.replace(/\bLNY_JIT\b/g, 'true');
  src = src.replace(/\bLNY_SECURE\b/g, 'true');
  src = src.replace(/\bLNY_DEBUG\b/g, 'false');

  // --- hard crash (anti-tamper / anti-dump trip) ---
  src = src.replace(/LNY_CRASH\s*\(\s*\)/g,
    `(function()local _x=0 while true do _x=_x+1 if _x>999999999 then error("LNY")end end end)()`);
  src = src.replace(/LNY_POISON\s*\(\s*\)/g,
    `(function()while true do end end)()`);

  // --- encrypted string (multi-layer marker → later const pool) ---
  src = src.replace(/LNY_ENCSTR\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g, (_, q, str) => {
    const b64 = Buffer.from(str, 'utf8').toString('base64');
    // double wrap marker so simple grep is harder
    return `__LNYSTR__${b64}__`;
  });
  // LNY_STR same as ENCSTR
  src = src.replace(/LNY_STR\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g, (_, q, str) => {
    return `__LNYSTR__${Buffer.from(str, 'utf8').toString('base64')}__`;
  });

  // --- opaque true/false (boolean as expression noise) ---
  src = src.replace(/LNY_TRUE\s*\(\s*\)/g, '((1+1)==2)');
  src = src.replace(/LNY_FALSE\s*\(\s*\)/g, '((1+1)==3)');
  src = src.replace(/LNY_OPAQUE_TRUE\s*\(\s*\)/g,
    `(function()local a=1 local b=2 return (a+b)==3 end)()`);
  src = src.replace(/LNY_OPAQUE_FALSE\s*\(\s*\)/g,
    `(function()local a=1 local b=2 return (a*b)==5 end)()`);

  // --- precheck: if expr false → infinite loop ---
  src = src.replace(/LNY_PRECHECK\s*\(\s*([^)]+)\s*\)/g, (_, expr) => {
    return `(function()local _v=(${expr})if not _v then while true do end end return _v end)()`;
  });
  // assert-style
  src = src.replace(/LNY_ASSERT\s*\(\s*([^)]+)\s*\)/g, (_, expr) => {
    return `(function()if not(${expr})then while true do end end end)()`;
  });

  // --- anti-debug one-liner ---
  src = src.replace(/LNY_ANTIDEBUG\s*\(\s*\)/g,
    `(function()local ok,d=pcall(function()return debug end)if ok and type(d)=="table"and d.getinfo then local i=d.getinfo(1,"S")if not i or i.what~="Lua"then while true do end end end end)()`);

  // --- junk / stack noise ---
  src = src.replace(/LNY_STACKALLOC\s*\(\s*(\d+)\s*\)/g, (_, n) => {
    const cnt = Math.min(Math.max(parseInt(n) || 8, 1), 64);
    const arr = [];
    for (let i = 0; i < cnt; i++) arr.push(String(R(0, 255)));
    return `local ${RS(6)}={${arr.join(',')}}`;
  });
  src = src.replace(/LNY_JUNK\s*\(\s*(\d+)?\s*\)/g, (_, n) => {
    const cnt = Math.min(Math.max(parseInt(n) || 3, 1), 16);
    const parts = [];
    for (let i = 0; i < cnt; i++) {
      const v = RS(5);
      parts.push(`local ${v}=${R(1, 9999)};${v}=${v}+${R(0, 9)}`);
    }
    return `(function()${parts.join(';')}end)()`;
  });

  // --- random int (compile-time) ---
  src = src.replace(/LNY_RAND\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, (_, a, b) => {
    return String(R(parseInt(a), parseInt(b)));
  });
  src = src.replace(/LNY_RAND\s*\(\s*\)/g, () => String(R(0, 0x7fffffff)));

  // --- nop / opaque call ---
  src = src.replace(/LNY_NOP\s*\(\s*\)/g, '(function()end)()');
  src = src.replace(/LNY_OPAQUE_CALL\s*\(\s*([^)]+)\s*\)/g, (_, expr) => {
    return `(function(...)return ... end)(${expr})`;
  });

  // --- virtualize markers (hints for pipeline) ---
  src = src.replace(/LNY_NO_VIRTUALIZE\s*\(\s*(function[\s\S]*?end)\s*\)/gi, '$1');
  src = src.replace(/LNY_ENCFUNC\s*\(\s*(function[\s\S]*?end)\s*\)/gi, '$1');
  src = src.replace(/LNY_VIRTUALIZE\s*\(\s*(function[\s\S]*?end)\s*\)/gi, '$1');

  // --- kill / ban patterns (if someone left debug prints) ---
  src = src.replace(/LNY_STRIP\s*\(\s*(["'`])([\s\S]*?)\1\s*\)/g, 'nil');

  // --- integrity-ish: wrap value, fail closed ---
  src = src.replace(/LNY_WRAP\s*\(\s*([^)]+)\s*\)/g, (_, expr) => {
    const t = RS(4);
    return `(function()local ${t}=(${expr})if ${t}==nil then while true do end end return ${t}end)()`;
  });

  return src;
}

// ---- Opcode set (shuffled at gen time) ----
const BASE_OPS = [
  'MOVE','LOADK','LOADBOOL','LOADNIL','LOADINT',
  'GETGLOBAL','SETGLOBAL','GETTABLE','SETTABLE','NEWTABLE',
  'ADD','SUB','MUL','DIV','MOD','UNM','NOT','CONCAT',
  'JMP','EQ','LT','LE','TEST','CALL','RETURN'
];

// ============================================================
// Simple but REAL bytecode compiler (practical subset)
// Handles: numbers, strings, locals, + - * / %, print/calls,
//          assignment, return. Complex → fallback encrypted source.
// ============================================================
function compileToBytecode(source) {
  const constants = [];
  const addConst = (v) => {
    const s = String(v);
    const i = constants.indexOf(s);
    if (i >= 0) return i;
    constants.push(s);
    return constants.length - 1;
  };

  const lines = source.split('\n').map(l => l.trim()).filter(Boolean);
  const code = []; // {opName, a, b, c}
  const reg = Object.create(null);
  let nextReg = 1;
  let fallback = false;

  const alloc = (name) => {
    if (reg[name] !== undefined) return reg[name];
    reg[name] = nextReg++;
    return reg[name];
  };
  const emit = (opName, a = 0, b = 0, c = 0) => {
    code.push({ opName, a, b, c });
  };

  function emitExpr(expr, dest) {
    expr = expr.trim();
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      const n = Number(expr);
      if (Number.isInteger(n) && n >= -32768 && n <= 32767) {
        emit('LOADINT', dest, n, 0);
      } else {
        emit('LOADK', dest, addConst(expr), 0);
      }
      return true;
    }
    const sm = expr.match(/^(['"`])([\s\S]*)\1$/);
    if (sm) {
      emit('LOADK', dest, addConst(sm[2]), 0);
      return true;
    }
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
      if (reg[expr] !== undefined) emit('MOVE', dest, reg[expr], 0);
      else emit('GETGLOBAL', dest, addConst(expr), 0);
      return true;
    }
    // call name(...)  — must be before binary so print(x+y) works
    const call = expr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)$/);
    if (call) {
      const fname = call[1];
      const argsStr = call[2].trim();
      const freg = nextReg++;
      if (reg[fname] !== undefined) emit('MOVE', freg, reg[fname], 0);
      else emit('GETGLOBAL', freg, addConst(fname), 0);
      let nargs = 0;
      if (argsStr) {
        const parts = [];
        let cur = '', depth = 0, inQ = null;
        for (let i = 0; i < argsStr.length; i++) {
          const ch = argsStr[i];
          if (inQ) {
            cur += ch;
            if (ch === inQ && argsStr[i-1] !== '\\\\') inQ = null;
          } else if (ch === '"' || ch === "'" || ch === '`') {
            inQ = ch; cur += ch;
          } else if (ch === '(') { depth++; cur += ch; }
          else if (ch === ')') { depth--; cur += ch; }
          else if (ch === ',' && depth === 0) {
            parts.push(cur.trim()); cur = '';
          } else cur += ch;
        }
        if (cur.trim()) parts.push(cur.trim());
        for (const p of parts) {
          const ar = nextReg++;
          if (!emitExpr(p, ar)) return false;
          nargs++;
        }
      }
      // CALL f, nargs+1, nresults+1  (simplified)
      emit('CALL', freg, nargs + 1, 2);
      emit('MOVE', dest, freg, 0);
      return true;
    }
    // binary (after call)
    const bin = expr.match(/^(.+?)\s*([+\-*/%])\s*(.+)$/);
    if (bin) {
      const L = nextReg++, Rr = nextReg++;
      if (!emitExpr(bin[1], L)) return false;
      if (!emitExpr(bin[3], Rr)) return false;
      const map = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD' };
      emit(map[bin[2]] || 'ADD', dest, L, Rr);
      return true;
    }
    return false;
  }

  for (const line of lines) {
    let m = line.match(/^local\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (m) {
      const r = alloc(m[1]);
      if (!emitExpr(m[2], r)) { fallback = true; break; }
      continue;
    }
    m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (m) {
      const r = alloc(m[1]);
      if (!emitExpr(m[2], r)) { fallback = true; break; }
      continue;
    }
    m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)$/);
    if (m) {
      const tmp = nextReg++;
      if (!emitExpr(line, tmp)) { fallback = true; break; }
      continue;
    }
    m = line.match(/^return\s+(.+)$/);
    if (m) {
      if (!emitExpr(m[1], 0)) { fallback = true; break; }
      emit('RETURN', 0, 2, 0);
      continue;
    }
    if (line === 'return') {
      emit('RETURN', 0, 1, 0);
      continue;
    }
    fallback = true;
    break;
  }

  if (!fallback && code.length > 0) {
    emit('RETURN', 0, 1, 0);
    return { mode: 'bytecode', code, constants, maxReg: nextReg + 2, original: source };
  }
  return { mode: 'fallback', code: [], constants: [], maxReg: 8, original: source };
}

function encryptConst(str, keyA, keyB, keyC) {
  const buf = Buffer.from(String(str), 'utf8');
  const out = [];
  let k1 = keyA >>> 0, k2 = keyB >>> 0, k3 = keyC >>> 0;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i];
    b ^= (k1 & 0xFF);
    b = ((b << 3) | (b >> 5)) & 0xFF;
    b ^= (k2 & 0xFF);
    b ^= ((i * 41 + 19) & 0xFF);
    b = ((b << 5) | (b >> 3)) & 0xFF;
    b ^= (k3 & 0xFF);
    b ^= ((k1 >> 8) & 0xFF);
    out.push(b);
    k1 = (k1 * 1664525 + 1013904223) >>> 0;
    k2 = (k2 * 1103515245 + 12345) >>> 0;
    k3 = (k3 * 214013 + 2531011) >>> 0;
  }
  return out;
}

// ============================================================
// FINAL VM – real interpreter + TRUE lazy const decrypt
// ============================================================
function generateFinalVM(compiled, keys) {
  const { payloadKey, constKeyA, constKeyB, constKeyC } = keys;
  const V = {
    R: RS(5), pc: RS(4), C: RS(5), ops: RS(6),
    raw: RS(6), fn: RS(4), kA: RS(4), kB: RS(4), kC: RS(4),
    bc: RS(5), decC: RS(6)
  };

  // Shuffle opcodes
  const shuffled = SH([...BASE_OPS]);
  const OP = {};
  shuffled.forEach((name, i) => { OP[name] = i; });

  // bytecode encoded later (XOR threaded)

  // Encrypt constants – stay encrypted until LOADK
  const encConsts = (compiled.constants || []).map(c =>
    encryptConst(c, constKeyA, constKeyB, constKeyC)
  );

  const payloadEnc = (() => {
    const buf = Buffer.from(compiled.original, 'utf8');
    const out = [];
    let k = payloadKey >>> 0;
    for (let i = 0; i < buf.length; i++) {
      let b = buf[i];
      b ^= (k & 0xFF);
      b ^= ((i * 23) & 0xFF);
      b = ((b << 2) | (b >> 6)) & 0xFF;
      b ^= ((k >> 16) & 0xFF);
      out.push(b);
      k = (k * 1103515245 + 12345) >>> 0;
    }
    return out;
  })();

  let constTable = `local ${V.C}={}\n`;
  encConsts.forEach((arr, i) => {
    constTable += `${V.C}[${i}]={${arr.join(',')}}\n`;
  });

  // Lazy decrypt helper
  const lazyDec = `
local function ${V.decC}(data,ka,kb,kc)
  local out={}
  local k1,k2,k3=ka,kb,kc
  for i=1,#data do
    local b=data[i]
    b=bit32.bxor(b,bit32.band(bit32.rshift(k1,8),255))
    b=bit32.bxor(b,bit32.band(k3,255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x07),5),bit32.rshift(b,3))
    b=bit32.band(b,255)
    b=bit32.bxor(b,bit32.band((i-1)*41+19,255))
    b=bit32.bxor(b,bit32.band(k2,255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x1F),3),bit32.rshift(b,5))
    b=bit32.band(b,255)
    b=bit32.bxor(b,bit32.band(k1,255))
    out[i]=string.char(b)
    k1=bit32.band(k1*1664525+1013904223,0xFFFFFFFF)
    k2=bit32.band(k2*1103515245+12345,0xFFFFFFFF)
    k3=bit32.band(k3*214013+2531011,0xFFFFFFFF)
  end
  return table.concat(out)
end
local function __lazy(idx)
  local v=${V.C}[idx]
  if type(v)=="table" then
    v=${V.decC}(v,${V.kA},${V.kB},${V.kC})
    ${V.C}[idx]=v
  end
  return v
end
`;

  // ===== Threaded code + XOR next-handler (VMProtect-style) =====
  const xorSeed = R(0x1000, 0x7FFFFF);
  // Encode stream: each op XORed with rotating key; operands plain
  let bcFlat = [];
  let xk = xorSeed >>> 0;
  if (compiled.mode === 'bytecode') {
    for (const ins of compiled.code) {
      const opNum = OP[ins.opName] !== undefined ? OP[ins.opName] : 0;
      const encOp = (opNum ^ (xk & 0xFF)) >>> 0;
      bcFlat.push(encOp, ins.a | 0, ins.b | 0, ins.c | 0);
      xk = (xk * 1664525 + (opNum + 1) * 1013904223) >>> 0;
    }
  }

  // integrity over encoded stream
  let bcSum = 0;
  for (let i = 0; i < bcFlat.length; i++) {
    const luaI = i + 1;
    bcSum = (bcSum + ((bcFlat[i] | 0) * ((luaI % 97) + 1))) >>> 0;
  }

  // Build threaded handlers: each ends by decoding next op via XOR and returning next handler
  // Handler signature: function() -> nextHandler | "HALT" | rets
  const H = {
    R: V.R, bc: V.bc, ops: V.ops, vip: RS(4), xk: RS(4), tick: RS(4)
  };

  let handlers = `local ${V.ops}={}\n`;
  // shared state locals will be defined in body
  const handlerBodies = {
    MOVE: `R[a]=R[b]`,
    LOADK: `R[a]=__lazy(b)`,
    LOADBOOL: `R[a]=(b~=0)`,
    LOADNIL: `R[a]=nil`,
    LOADINT: `R[a]=b`,
    GETGLOBAL: `R[a]=_ENV[__lazy(b)]`,
    SETGLOBAL: `_ENV[__lazy(b)]=R[a]`,
    GETTABLE: `R[a]=(R[b] or {})[R[c]]`,
    SETTABLE: `(R[a] or {})[R[b]]=R[c]`,
    NEWTABLE: `R[a]={}`,
    ADD: `R[a]=(R[b] or 0)+(R[c] or 0)`,
    SUB: `R[a]=(R[b] or 0)-(R[c] or 0)`,
    MUL: `R[a]=(R[b] or 0)*(R[c] or 0)`,
    DIV: `R[a]=(R[b] or 0)/(R[c] or 1)`,
    MOD: `R[a]=(R[b] or 0)%(R[c] or 1)`,
    UNM: `R[a]=-(R[b] or 0)`,
    NOT: `R[a]=not R[b]`,
    CONCAT: `R[a]=tostring(R[b] or "")..tostring(R[c] or "")`,
    JMP: `vip=vip+b`,
    EQ: `R[a]=(R[b]==R[c])`,
    LT: `R[a]=(R[b]<R[c])`,
    LE: `R[a]=(R[b]<=R[c])`,
    TEST: `if not R[a] then vip=vip+b end`,
    CALL: `do local f=R[a] if type(f)=="function" then local n=math.max((b or 1)-1,0) local args={} for i=1,n do args[i]=R[a+i] end local rets={f(unpack(args,1,n))} local m=math.max((c or 1)-1,0) for i=1,m do R[a+i-1]=rets[i] end if m==0 then R[a]=rets[1] end end end`,
    RETURN: `do local n=math.max((b or 1)-1,0) local rets={} for i=0,n-1 do rets[i+1]=R[a+i] end kA,kB,kC=0,0,0 for i=0,#__rawR do __rawR[i]=nil end return "HALT",rets end`,
  };

  // dispatcher stub embedded in every handler (threaded)
  const dispatchStub = `
  tick=tick+1
  if tick%32==0 and __antiJail()<6 then while true do end end
  if vip>#bc then return "HALT",{} end
  local enc=bc[vip]; vip=vip+1
  local a=bc[vip] or 0; vip=vip+1
  local b=bc[vip] or 0; vip=vip+1
  local c=bc[vip] or 0; vip=vip+1
  local op=bit32.bxor(enc,bit32.band(xk,255))
  xk=bit32.band(xk*1664525+(op+1)*1013904223,0xFFFFFFFF)
`;

  for (const [name, num] of Object.entries(OP)) {
    const bodyOp = handlerBodies[name] || '';
    if (name === 'RETURN') {
      handlers += `${V.ops}[${num}]=function()
${dispatchStub}
  ${bodyOp}
end
`;
    } else {
      handlers += `${V.ops}[${num}]=function()
${dispatchStub}
  ${bodyOp}
  local nh=${V.ops}[op]
  if not nh then while true do end end
  return nh
end
`;
    }
  }

  // Wait - there's a logic bug. In threaded style, the CURRENT handler should execute CURRENT op's body,
  // then fetch NEXT op and return next handler. The dispatchStub currently decodes op at start which
  // is correct for "handler is entered knowing it's the right one" OR "handler fetches its own op".
  //
  // VMProtect style often: central only picks first; each handler fetches operands for itself
  // then encodes jump to next.
  //
  // Better model:
  // Entry: decode first op, call handlers[op]
  // Handler: receives that it was selected for THIS op; reads a,b,c; does work; decodes NEXT op; returns handlers[next]
  //
  // So dispatchStub should NOT decode op at the beginning of handler - the handler is already the right one.
  // Operands only at start; at end decode next.

  // Rebuild handlers correctly
  handlers = `local ${V.ops}={}\n`;
  const fetchOperands = `
  if vip>#bc then return "HALT",{} end
  local a=bc[vip] or 0; vip=vip+1
  local b=bc[vip] or 0; vip=vip+1
  local c=bc[vip] or 0; vip=vip+1
  tick=tick+1
  if tick%32==0 and __antiJail()<6 then while true do end end
`;
  const fetchNext = `
  if vip>#bc then return "HALT",{} end
  local enc=bc[vip]; vip=vip+1
  local nop=bit32.bxor(enc,bit32.band(xk,255))
  xk=bit32.band(xk*1664525+(nop+1)*1013904223,0xFFFFFFFF)
  local nh=${V.ops}[nop]
  if not nh then while true do end end
  return nh
`;

  for (const [name, num] of Object.entries(OP)) {
    const bodyOp = handlerBodies[name] || '';
    if (name === 'RETURN') {
      handlers += `${V.ops}[${num}]=function()
${fetchOperands}
  ${bodyOp}
end
`;
    } else {
      handlers += `${V.ops}[${num}]=function()
${fetchOperands}
  ${bodyOp}
${fetchNext}
end
`;
    }
  }

  const isBC = compiled.mode === 'bytecode' && bcFlat.length > 0;

  // first opcode encoded with xorSeed
  let firstEnc = 0;
  let firstOp = 0;
  if (isBC && compiled.code.length) {
    firstOp = OP[compiled.code[0].opName] || 0;
    firstEnc = (firstOp ^ (xorSeed & 0xFF)) >>> 0;
  }

  const body = `
-- FINAL VM v6.4 · threaded XOR handlers (VMProtect-style) + lazy const + anti-jail
local ${V.kA}=${constKeyA}
local ${V.kB}=${constKeyB}
local ${V.kC}=${constKeyC}
${lazyDec}
${constTable}
${handlers}

local function __antiJail()
  local s=0
  local ok,d=pcall(function() return debug end)
  if not ok or type(d)~="table" then s=s+4
  else
    if d.getinfo then
      local i=d.getinfo(1,"S")
      if i and i.what=="Lua" then s=s+2 end
      local i2=d.getinfo(2,"S")
      if i2 and i2.what=="C" then s=s+1 end
    end
    if d.sethook or d.getlocal or d.getupvalue then s=s+1 end
  end
  if type(getfenv)=="function" then
    local e=getfenv(1)
    if e==_G or e==_ENV or e==nil then s=s+3 end
  else s=s+2 end
  if type(bit32)=="table" and bit32.bxor then s=s+1 end
  if type(string)=="table" and type(string.dump)=="function" then
    local ok2,bd=pcall(string.dump,function()end)
    if ok2 and type(bd)=="string" and #bd>0 then s=s+1 end
  end
  return s
end
if __antiJail()<7 then while true do end end
local __ls=loadstring or load
if type(__ls)~="function" then while true do end end

local __rawR={}
for i=0,${Math.max(compiled.maxReg||16,16)} do __rawR[i]=nil end
local R=setmetatable({},{
  __index=function(_,k)
    if type(k)~="number" or k<0 or k>512 then while true do end end
    return __rawR[k]
  end,
  __newindex=function(_,k,v)
    if type(k)~="number" or k<0 or k>512 then while true do end end
    __rawR[k]=v
  end,
  __metatable="LNY"
})
local __rawC=${V.C}
${V.C}=setmetatable({},{
  __index=function(_,k)
    if type(k)~="number" then while true do end end
    return __rawC[k]
  end,
  __newindex=function(_,k,v)
    if type(k)~="number" then while true do end end
    __rawC[k]=v
  end,
  __metatable="LNY"
})

${isBC ? `
local bc={${bcFlat.join(',')}}
local __sum=0
for i=1,#bc do __sum=__sum+(bc[i]*(i%97+1)) end
__sum=bit32.band(__sum,0xFFFFFFFF)
if __sum~=${bcSum} then while true do end end

-- threaded FDE: each handler contains fetch-next + XOR decode + tail to next handler
local vip=1
local xk=${xorSeed}
local tick=0
local kA,kB,kC=${V.kA},${V.kB},${V.kC}

-- bootstrap: decode first opcode, enter handler chain
local enc0=bc[vip]; vip=vip+1
local op0=bit32.bxor(enc0,bit32.band(xk,255))
xk=bit32.band(xk*1664525+(op0+1)*1013904223,0xFFFFFFFF)
local h=${V.ops}[op0]
if not h then while true do end end
while h do
  local r1,r2=h()
  if r1=="HALT" then
    kA,kB,kC=0,0,0
    for i=0,#__rawR do __rawR[i]=nil end
    if r2 then return unpack(r2) end
    return
  end
  h=r1
end
kA,kB,kC=0,0,0
return
` : `
local ${V.raw}={${payloadEnc.join(',')}}
local function __decP(data,key)
  local out={}
  local k=key
  for i=1,#data do
    local b=data[i]
    b=bit32.bxor(b,bit32.band(bit32.rshift(k,16),255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x3F),6),bit32.rshift(b,2))
    b=bit32.band(b,255)
    b=bit32.bxor(b,bit32.band((i-1)*23,255))
    b=bit32.bxor(b,bit32.band(k,255))
    out[i]=string.char(b)
    k=bit32.band(k*1103515245+12345,0xFFFFFFFF)
  end
  return table.concat(out)
end
local src=__decP(${V.raw},${payloadKey})
${V.kA},${V.kB},${V.kC}=0,0,0
local __env=setmetatable({},{__index=_ENV or _G,__newindex=function(t,k,v) rawset(t,k,v) end,__metatable="LNY"})
local ${V.fn}=loadstring(src)
if type(${V.fn})~="function" then while true do end end
if setfenv then pcall(setfenv,${V.fn},__env) end
return ${V.fn}()
`}
`;
  return body;
}

function generateNestVM1(finalVMSrc, secondaryKey) {
  const V = { anti: RS(7), score: RS(6), k2: RS(5), raw: RS(8), dec: RS(7), fn: RS(6) };
  const finalEnc = (() => {
    const buf = Buffer.from(finalVMSrc, 'utf8');
    const out = [];
    let k = secondaryKey >>> 0;
    for (let i = 0; i < buf.length; i++) {
      let b = buf[i];
      b ^= (k & 0xFF);
      b ^= ((i * 37 + 11) & 0xFF);
      b = ((b << 4) | (b >> 4)) & 0xFF;
      b ^= ((k >> 12) & 0xFF);
      out.push(b);
      k = (k * 214013 + 2531011) >>> 0;
    }
    return out;
  })();
  return `
local function ${V.anti}()
  local s=0
  if type(getfenv)=="function" then
    local e=getfenv(1)
    if e==_G or e==_ENV or e==nil then s=s+4 end
  else s=s+3 end
  local ok,d=pcall(function() return debug end)
  if not ok or type(d)~="table" then s=s+6
  elseif d.getinfo then
    local i=d.getinfo(1,"S")
    if i and i.what=="Lua" then s=s+3 end
    -- extra: detect common jail hooks
    if d.getupvalue or d.setupvalue then s=s+1 end
  end
  local t={9,8,7,6,5}
  if #t==5 and t[2]==8 then s=s+2 end
  local x=0
  for i=1,30 do x=x+i*i end
  if x==9455 then s=s+3 end
  if type(bit32)=="table" then s=s+1 end
  -- metatable probe
  local mt=getmetatable or function() return nil end
  if mt(_G)==nil then s=s+1 end
  return s
end
local ${V.score}=${V.anti}()
if ${V.score}<8 then while true do end end
local ${V.k2}=${secondaryKey}
local ${V.raw}={${finalEnc.join(',')}}
local function ${V.dec}(data,key)
  local out={}
  local k=key
  for i=1,#data do
    local b=data[i]
    b=bit32.bxor(b,bit32.band(bit32.rshift(k,12),255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x0F),4),bit32.rshift(b,4))
    b=bit32.band(b,255)
    b=bit32.bxor(b,bit32.band((i-1)*37+11,255))
    b=bit32.bxor(b,bit32.band(k,255))
    out[i]=string.char(b)
    k=bit32.band(k*214013+2531011,0xFFFFFFFF)
  end
  return table.concat(out)
end
local finalSrc=${V.dec}(${V.raw},${V.k2})
${V.k2}=0
local ${V.fn}=loadstring(finalSrc)
if type(${V.fn})~="function" then while true do end end
return ${V.fn}()
`;
}

function buildNested(compiled) {
  const masterKey = R(0x2A3B4C5D, 0x7E6F5A4B);
  const secondaryKey = R(0x11112222, 0x6EEEEEEE);
  const constKeyA = R(0x10000000, 0x6FFFFFFF);
  const constKeyB = R(0x20000000, 0x5FFFFFFF);
  const constKeyC = R(0x30000000, 0x4FFFFFFF);
  const payloadKey = R(0x3F2E1D0C, 0x7A6B5C4D);
  const keys = { payloadKey, constKeyA, constKeyB, constKeyC };

  let finalVMSrc = generateFinalVM(compiled, keys);
  finalVMSrc = minifyLua(finalVMSrc);
  let nest1Src = generateNestVM1(finalVMSrc, secondaryKey);
  nest1Src = minifyLua(nest1Src);

  const nest1Enc = (() => {
    const buf = Buffer.from(nest1Src, 'utf8');
    const out = [];
    let k = masterKey >>> 0;
    for (let i = 0; i < buf.length; i++) {
      let b = buf[i];
      b ^= (k & 0xFF);
      b ^= ((i * 29) & 0xFF);
      b = ((b << 3) | (b >> 5)) & 0xFF;
      b ^= ((k >> 8) & 0xFF);
      out.push(b);
      k = (k * 1103515245 + 12345) >>> 0;
    }
    return out;
  })();

  const V = { keyvm: RS(8), anti: RS(7), score: RS(6), k: RS(5), raw: RS(9), dec: RS(7), fn: RS(6) };

  return `
local function ${V.keyvm}()
  local function ${V.anti}()
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
    if type(bit32)=="table" and bit32.bxor then s=s+2 end
    if type(loadstring)=="function" or type(load)=="function" then s=s+1 end
    return s
  end
  local ${V.score}=${V.anti}()
  if ${V.score}<7 then return bit32.bxor(${masterKey},0xDEADBEEF) end
  return ${masterKey}
end
local ${V.k}=${V.keyvm}()
local ${V.raw}={${nest1Enc.join(',')}}
local function ${V.dec}(data,key)
  local out={}
  local k=key
  for i=1,#data do
    local b=data[i]
    b=bit32.bxor(b,bit32.band(bit32.rshift(k,8),255))
    b=bit32.bor(bit32.lshift(bit32.band(b,0x1F),5),bit32.rshift(b,3))
    b=bit32.band(b,255)
    b=bit32.bxor(b,bit32.band((i-1)*29,255))
    b=bit32.bxor(b,bit32.band(k,255))
    out[i]=string.char(b)
    k=bit32.band(k*1103515245+12345,0xFFFFFFFF)
  end
  return table.concat(out)
end
local nestSrc=${V.dec}(${V.raw},${V.k})
${V.k}=0
local ${V.fn}=loadstring(nestSrc)
if type(${V.fn})~="function" then while true do end end
return ${V.fn}()
`;
}

function multiLayerPack(code) {
  const k1 = R(1, 255), k2 = R(1, 255);
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
  const dataVar = RS(11), kA = RS(5), kB = RS(5), kD = RS(5);
  const d1 = RS(8), d2 = RS(8), d3 = RS(8);
  // already-dense outer loader (minimal whitespace)
  const outer = `return(function()local ${dataVar}={${layer3.join(',')}}local ${kA}=${k1}local ${kB}=${k2}local ${kD}=${layer3Key}local function ${d3}(t,key)local s={}for i=1,#t do s[i]=string.char(bit32.bxor(t[i],key,bit32.band((i-1)*7,255)))end return table.concat(s)end local function ${d2}(s)local alph="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_\`{|}~"local map={}for i=1,#alph do map[string.sub(alph,i,i)]=i-1 end local bytes={}for i=1,#s,5 do local n=0 for j=0,4 do n=n*85+(map[string.sub(s,i+j,i+j)] or 0)end for j=3,0,-1 do bytes[#bytes+1]=math.floor(n/(256^j))%256 end end return bytes end local function ${d1}(bytes,k1,k2)local out={}for i=1,#bytes do local b=bytes[i]b=bit32.bxor(b,bit32.band(bit32.rshift(i-1,2),255))b=bit32.bor(bit32.lshift(bit32.band(b,0x1F),5),bit32.rshift(b,3))b=bit32.band(b,255)b=bit32.bxor(b,k2)b=bit32.bxor(b,bit32.band((i-1)*31+17,255))b=bit32.bxor(b,k1)out[i]=string.char(b)end return table.concat(out)end local s3=${d3}(${dataVar},${kD})local b2=${d2}(s3)local src=${d1}(b2,${kA},${kB})local fn=loadstring(src)if type(fn)~="function"then while true do end end return fn()end)()`;
  return outer;
}

// Aggressive minify: strip comments, collapse whitespace, kill newlines
function minifyLua(src) {
  if (!src) return src;
  let s = src
    .replace(/--\[\[[\s\S]*?\]\]/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([{}()\[\];,=<>~+\-*/%])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // keep minimal spaces where Lua needs them (keywords)
  s = s
    .replace(/\blocal\b/g, ' local ')
    .replace(/\bfunction\b/g, ' function ')
    .replace(/\breturn\b/g, ' return ')
    .replace(/\bend\b/g, ' end ')
    .replace(/\bthen\b/g, ' then ')
    .replace(/\belse\b/g, ' else ')
    .replace(/\belseif\b/g, ' elseif ')
    .replace(/\bfor\b/g, ' for ')
    .replace(/\bwhile\b/g, ' while ')
    .replace(/\bdo\b/g, ' do ')
    .replace(/\bin\b/g, ' in ')
    .replace(/\bif\b/g, ' if ')
    .replace(/\bnot\b/g, ' not ')
    .replace(/\band\b/g, ' and ')
    .replace(/\bor\b/g, ' or ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return s;
}

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
  const compiled = compileToBytecode(code);
  let nested = buildNested(compiled);
  nested = minifyLua(nested);
  const packed = multiLayerPack(nested);
  // final outer already compact; header minimal
  return `--LNY v6.4 anti-dump/jail mode:${compiled.mode}\n` + packed;
}

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Litnyang v6.4 · Anti-Dump + Compact</title>
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
.bar{margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button{background:#9333ea;color:#fff;border:none;padding:11px 24px;border-radius:8px;font-weight:600;cursor:pointer}
button:hover{background:#7e22ce}
button:disabled{opacity:.45;cursor:not-allowed}
button.secondary{background:#27272a;border:1px solid #3f3f46}
button.secondary:hover{background:#3f3f46}
button.secondary:disabled{opacity:.35}
.status{font-size:.8rem;opacity:.55}
.info{margin-top:22px;padding:14px;background:#18181b;border-radius:10px;border:1px solid #27272a;font-size:.8rem;line-height:1.55;opacity:.85}
.badge{display:inline-block;background:#581c87;color:#e9d5ff;padding:2px 8px;border-radius:999px;font-size:.7rem;margin-left:8px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Litnyang v6.4 <span class="badge">Anti-Dump</span></h1>
  <p class="sub">Compact · Anti-dump · Anti-jail · Bytecode · Lazy const · MT traps</p>
  <div class="grid">
    <div>
      <label>Input Lua</label>
      <textarea id="in" placeholder="print(123)
local x = 10
local y = 20
print(x + y)
local s = &quot;hello&quot;
print(s)"></textarea>
    </div>
    <div>
      <label>Output</label>
      <textarea id="out" readonly></textarea>
    </div>
  </div>
  <div class="bar">
    <button id="btn" onclick="go()">Obfuscate</button>
    <button id="dl" class="secondary" onclick="download()" disabled>Download .lua</button>
    <span class="status" id="st"></span>
  </div>
  <div class="info">
    <b>v6.4 Threaded XOR VM (VMProtect-style)</b><br>
    • 각 핸들러가 다음 핸들러를 XOR 디코드 후 직접 연결 (threaded code)<br>
    • 중앙 switch 없음 · FDE가 핸들러 내부에 분산<br>
    • lazy const · anti-dump · MT traps · minify · LNY_/LTY_ 매크로
  </div>
</div>
<script>
let lastOut = '';
async function go(){
  const btn=document.getElementById('btn'), dl=document.getElementById('dl'), st=document.getElementById('st');
  btn.disabled=true; dl.disabled=true; st.textContent='Working...';
  try{
    const r=await fetch('/obfuscate',{method:'POST',headers:{'Content-Type':'text/plain'},body:document.getElementById('in').value});
    const t=await r.text();
    lastOut = t;
    document.getElementById('out').value=t;
    st.textContent='Done · '+t.length.toLocaleString()+' bytes';
    dl.disabled = !t || t.startsWith('-- Litnyang: empty') || t.startsWith('-- Litnyang Error');
  }catch(e){st.textContent='Error: '+e.message; lastOut='';}
  finally{btn.disabled=false}
}
function download(){
  if(!lastOut) return;
  const blob = new Blob([lastOut], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'litnyang_v6_3_' + Date.now() + '.lua';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 200);
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
  console.log(`[Litnyang v6.4] Anti-dump + Compact + Jail · port ${PORT}`);
});
