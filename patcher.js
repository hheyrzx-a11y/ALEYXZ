// patcher.js
"use strict";

const CONTAINERS = new Set(["moov","trak","mdia","minf","dinf","edts","stbl","udta","meta","ilst","moof","traf"]);
const ENC_TAG = "Lavf59.27.100";
const CHUNK = 1024;
const ZERO_BYTES = new Uint8Array([0,0,0,4,0,0,0,0]);

const u32 = (a,o) => (a[o]<<24|a[o+1]<<16|a[o+2]<<8|a[o+3])>>>0;
const i32 = (a,o) => a[o]<<24|a[o+1]<<16|a[o+2]<<8|a[o+3];
const w32 = v => new Uint8Array([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]);
const wp32 = (a,o,v) => { a[o]=(v>>>24)&255; a[o+1]=(v>>>16)&255; a[o+2]=(v>>>8)&255; a[o+3]=v&255; };
const box = (t,d) => { const b=new Uint8Array(d.length+8); b.set(w32(d.length+8),0); for(let i=0;i<4;i++) b[i+4]=t.charCodeAt(i); b.set(d,8); return b; };
const fbox = (t,d) => { const b=new Uint8Array(d.length+12); b.set(w32(d.length+12),0); for(let i=0;i<4;i++) b[i+4]=t.charCodeAt(i); b.set(d,12); return b; };
const rd4 = (a,o) => String.fromCharCode(a[o+4],a[o+5],a[o+6],a[o+7]);
const s2b = s => { const b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i)&255; return b; };
const cat = bufs => { let t=0; for(const b of bufs) t+=b.length; const r=new Uint8Array(t); let p=0; for(const b of bufs){ r.set(b,p); p+=b.length; } return r; };
const fseq = (b,s,st=0) => {
  L: for(let i=st;i+s.length<=b.length;i++){
    for(let j=0;j<s.length;j++) if(b[i+j]!==s[j]) continue L;
    return i;
  }
  return -1;
};
const rnd = (mn,mx) => Math.floor(Math.random()*(mx-mn+1))+mn;

function scan(buf, start, end) {
  const nodes = [];
  let ptr = start;
  while(ptr + 8 <= end) {
    const sz = u32(buf, ptr);
    let hdr = 8, total = sz;
    if(sz === 1) { if(ptr+16>end) break; hdr=16; }
    else if(sz === 0) total = end - ptr;
    if(!total || ptr+total > end) break;
    const n = { type: rd4(buf,ptr), start:ptr, end:ptr+total, size:total, header:hdr, children:null };
    let cs = ptr + hdr;
    if(n.type === "meta") cs += 4;
    if(CONTAINERS.has(n.type) && cs < ptr+total) n.children = scan(buf, cs, ptr+total);
    nodes.push(n);
    ptr += total;
  }
  return nodes;
}

const raw = (b,n) => b.subarray(n.start, n.end);
const inner = (b,n) => b.subarray(n.start+n.header, n.end);
const get = (n,t) => { if(!n.children) return null; for(let i=0;i<n.children.length;i++) if(n.children[i].type===t) return n.children[i]; return null; };
const walk = (n,arr) => { let c=n; for(const p of arr){ c=get(c,p); if(!c) return null; } return c; };
const htype = (b,tk) => { const h=walk(tk,["mdia","hdlr"]); if(!h) return null; const i=inner(b,h); return String.fromCharCode(i[8],i[9],i[10],i[11]); };
const stbl = tk => walk(tk,["mdia","minf","stbl"]);

function parseStsz(b, n) {
  const d = inner(b,n), ss = u32(d,4), cnt = u32(d,8), arr = [];
  if(ss !== 0) for(let i=0;i<cnt;i++) arr.push(ss);
  else for(let i=0,p=12;i<cnt&&p+4<=d.length;i++,p+=4) arr.push(u32(d,p));
  return arr;
}

function parseStts(b, n) {
  const d = inner(b,n), cnt = u32(d,4), arr = [];
  for(let i=0,p=8;i<cnt&&p+8<=d.length;i++,p+=8) arr.push([u32(d,p), u32(d,p+4)]);
  return arr;
}

function resolveChunks(b, sb, mdatStart, sizes) {
  const co = get(sb,"stco")||get(sb,"co64"), sc = get(sb,"stsc");
  if(!co||!sc) throw new Error("stco/stsc faltantes");
  const offs = (() => {
    const d = inner(b,co), is64 = co.type==="co64", cnt = u32(d,4), arr = [];
    for(let i=0,p=8;i<cnt&&p+(is64?8:4)<=d.length;i++,p+=is64?8:4)
      arr.push(is64 ? Number(BigInt(u32(d,p))<<32n|BigInt(u32(d,p+4))) : u32(d,p));
    return arr;
  })();
  const sctbl = (() => {
    const d = inner(b,sc), cnt = u32(d,4), arr = [];
    for(let i=0,p=8;i<cnt&&p+12<=d.length;i++,p+=12) arr.push([u32(d,p), u32(d,p+4)]);
    return arr;
  })();
  const cps = offs.map((_,idx) => { let r=1; for(const[fc,sp] of sctbl) if(idx+1>=fc) r=sp; return r; });
  const blocks = []; let si = 0;
  for(let i=0;i<offs.length;i++) {
    let off = offs[i] - mdatStart;
    for(let j=0;j<cps[i];j++) { const sz=sizes[si]; blocks.push(b.subarray(mdatStart+off, mdatStart+off+sz)); off+=sz; si++; }
  }
  return blocks;
}

function patchVideo(rawBuf) {
  const tree = scan(rawBuf, 0, rawBuf.length);
  const ftyp = tree.find(b=>b.type==="ftyp");
  const moov = tree.find(b=>b.type==="moov");
  const mdat = tree.find(b=>b.type==="mdat");
  if(!ftyp||!moov||!mdat) throw new Error("Archivo MP4 inválido");

  const mdatStart = mdat.start;
  const tracks = (moov.children||[]).filter(b=>b.type==="trak");
  const vTrak = tracks.find(b=>htype(rawBuf,b)==="vide");
  const aTrak = tracks.find(b=>htype(rawBuf,b)==="soun");
  if(!vTrak||!aTrak) throw new Error("Se requieren pistas de video y audio");

  const mvhd = get(moov,"mvhd"); if(!mvhd) throw new Error("mvhd faltante");
  const mvhdD = inner(rawBuf,mvhd);
  const movieScale = u32(mvhdD,12);
  const movieDur = u32(mvhdD,16);
  const movieDurSec = movieDur / movieScale;

  const vSb = stbl(vTrak), aSb = stbl(aTrak);
  const vMdhd = walk(vTrak,["mdia","mdhd"]), vTkhd = get(vTrak,"tkhd");
  const aMdhd = walk(aTrak,["mdia","mdhd"]), aTkhd = get(aTrak,"tkhd");

  const vTimeScale = u32(inner(rawBuf,vMdhd), 12);
  const vDuration = u32(inner(rawBuf,vMdhd), 16);
  const vDurSec = vDuration / vTimeScale;

  const aTimeScale = u32(inner(rawBuf,aMdhd), 12);
  const aDuration = u32(inner(rawBuf,aMdhd), 16);
  const aDurSec = aDuration / aTimeScale;

  const vStts = get(vSb,"stts");
  const vSttsEntries = parseStts(rawBuf, vStts);
  let totalVSamples = 0;
  for(const[c] of vSttsEntries) totalVSamples += c;

  const realFps = totalVSamples / vDurSec;
  const correctSampleDelta = Math.round(vTimeScale / realFps);

  const aStts = get(aSb,"stts");
  const aSizes = parseStsz(rawBuf, get(aSb,"stsz"));
  const totalASamples = aSizes.length;

  if(aStts) {
    const cnt = u32(inner(rawBuf,aStts),4);
    for(let i=0;i<cnt;i++) {
      const sc = u32(inner(rawBuf,aStts), 8+i*8);
      const sd = u32(inner(rawBuf,aStts), 12+i*8);
      if(sd === 1 && sc >= 100) throw new Error("Video ya parchado");
    }
  }

  const aEdtsOff = (() => {
    const e = get(aTrak,"edts"); if(!e) return 0;
    const el = get(e,"elst"); return el ? i32(inner(rawBuf,el),12) : 0;
  })();

  const vCtts = get(vSb,"ctts");
  let cttsArr = null;
  if(vCtts) {
    const cd = inner(rawBuf, vCtts), ver = cd[0], cnt = u32(cd,4), arr = [];
    for(let i=0,p=8;i<cnt&&p+8<=cd.length;i++,p+=8) {
      const sc = u32(cd,p), ov = ver===1 ? i32(cd,p+4) : u32(cd,p+4);
      for(let j=0;j<sc;j++) arr.push(ov);
    }
    cttsArr = arr;
  }

  const vSizes = parseStsz(rawBuf, get(vSb,"stsz"));
  const minCtts = cttsArr ? Math.min(...cttsArr) : 0;

  const vChunks = resolveChunks(rawBuf, vSb, mdatStart, vSizes);
  const aChunks = resolveChunks(rawBuf, aSb, mdatStart, aSizes);
  let vBytes = 0; for(const c of vChunks) vBytes += c.length;
  let aBytes = 0; for(const c of aChunks) aBytes += c.length;

  const vBR = Math.floor(8 * vBytes * vTimeScale / vDuration);
  const aBR = Math.floor(8 * aBytes * aTimeScale / aDuration);

  const mapped = vChunks.map((_,i) => Math.floor((correctSampleDelta * i * aTimeScale + vTimeScale * CHUNK) / (vTimeScale * CHUNK * 2)));
  const groups = [];
  for(let i=0;i<mapped.length;i++) { const idx=mapped[i]; if(!groups[idx]) groups[idx]=[]; groups[idx].push(vChunks[i]); }
  const activeG = groups.filter(g=>g.length>0);
  const gCount = activeG.length;

  const outFtyp = box("ftyp", cat([s2b("isom"),w32(512),s2b("isom"),s2b("iso2"),s2b("avc1"),s2b("mp41")]));
  const mvhdRest = mvhdD.subarray(20,100);
  const outMvhd = box("mvhd", cat([w32(0),w32(0),w32(0),w32(movieScale),w32(movieDur),mvhdRest]));

  const patchTkhd = (tk, trackId, dur) => {
    const d = inner(rawBuf, get(tk,"tkhd")), o = new Uint8Array(d.length);
    o.set(d); o.set(w32(3),0); o.set(w32(0),4); o.set(w32(0),8);
    wp32(o,12, trackId); o.set(w32(dur),20);
    return box("tkhd", o);
  };

  const vStsd = get(vSb,"stsd");
  const vStsdD = raw(rawBuf,vStsd).subarray(16);
  const codecs = ["avcC","hvcC","hevC","vpcC","av1C","dvhe","dvh1"];
  let cfgPos = -1;
  for(const c of codecs) {
    let p = 16;
    while(true) {
      const idx = fseq(vStsdD, s2b(c), p);
      if(idx < 0) break;
      const len = u32(vStsdD, idx-4);
      if(len >= 8 && idx-4+len <= vStsdD.length) { cfgPos = idx-4+len; break; }
      p = idx+1;
    }
    if(cfgPos >= 0) break;
  }
  
  const extBoxes = [vStsdD.subarray(0,cfgPos)];
  const colrPos = fseq(vStsdD, s2b("colr"));
  if(colrPos >= 0) {
    const cs = colrPos-4, cd = vStsdD.subarray(cs, cs+u32(vStsdD,cs));
    if(String.fromCharCode(cd[8],cd[9],cd[10],cd[11]) === "nclc") {
      const m = new Uint8Array(cd.length+1); m.set(cd,0); m.set(s2b("nclx"),8); m[m.length-1]=0; wp32(m,0,m.length); extBoxes.push(m);
    } else extBoxes.push(cd);
  } else {
    extBoxes.push(box("colr", cat([s2b("nclx"),new Uint8Array([0,1]),new Uint8Array([0,1]),new Uint8Array([0,1]),new Uint8Array([0])])));
  }
  extBoxes.push(cat([w32(20),s2b("btrt"),w32(0),w32(vBR),w32(vBR)]));
  const joinedExt = cat(extBoxes);
  wp32(joinedExt,0,joinedExt.length);

  const out_vStts = fbox("stts", cat([w32(1),w32(totalVSamples),w32(correctSampleDelta)]));
  const vStss = get(vSb,"stss");
  const out_vStss = vStss ? raw(rawBuf,vStss) : null;
  const out_vCtts = cttsArr ? fbox("ctts", cat([w32(totalVSamples), cat(cttsArr.map(o => cat([w32(1), w32(o===1?1:Math.round((o-minCtts)))])))])) : null;

  const gSizes = activeG.map(g=>g.length);
  const compact = [];
  for(const s of gSizes) {
    if(compact.length && compact[compact.length-1][1]===s) compact[compact.length-1][0]++;
    else compact.push([1,s]);
  }
  const stscBody = [w32(compact.length)];
  let cid = 1;
  for(const[c,sz] of compact) { stscBody.push(w32(cid),w32(sz),w32(1)); cid+=c; }

  const out_vStsc = fbox("stsc", cat(stscBody));
  const out_vStsz = fbox("stsz", cat([w32(0),w32(totalVSamples),cat(vSizes.map(w32))]));
  const out_vStco = fbox("stco", cat([w32(gCount), new Uint8Array(4*gCount)]));

  const newVStbl = [box("stsd", cat([w32(0),w32(1),joinedExt]))];
  newVStbl.push(out_vStts);
  if(out_vStss) newVStbl.push(out_vStss);
  if(out_vCtts) newVStbl.push(out_vCtts);
  newVStbl.push(out_vStsc, out_vStsz, out_vStco);
  const finalVStbl = box("stbl", cat(newVStbl));

  const aStsdN = get(aSb,"stsd");
  const aStsdD = new Uint8Array(raw(rawBuf,aStsdN).subarray(16));
  const esdsPos = fseq(aStsdD, s2b("esds"));
  if(esdsPos < 0) throw new Error("esds de audio no encontrado");

  const es = esdsPos-4;
  const esdsBox = new Uint8Array(aStsdD.subarray(es, es+u32(aStsdD,es)));
  esdsBox[17]=0; esdsBox[18]=2; esdsBox[26]=21; esdsBox[27]=0; esdsBox[28]=0; esdsBox[29]=0;
  esdsBox.set(w32(aBR),30); esdsBox.set(w32(aBR),34);

  const aPadBuf = new Uint8Array(28);
  aPadBuf.set(aStsdD.subarray(8,16),0);
  aPadBuf.set(aStsdD.subarray(24,28),16);
  aPadBuf.set(aStsdD.subarray(32,36),24);

  const newAStsd = cat([aStsdD.subarray(0,8),aPadBuf,esdsBox,cat([w32(20),s2b("btrt"),w32(0),w32(aBR),w32(aBR)])]);
  wp32(newAStsd,0,newAStsd.length);

  const r1 = rnd(6,12), r2 = rnd(50,100);
  const fakeCount = Math.floor(totalASamples * r1 / 100);
  const fakeSizes = [];
  for(let i=0;i<fakeCount;i++) fakeSizes.push(r2 + rnd(0,60));
  const fakeData = cat(fakeSizes.map(sz => {
    const b = new Uint8Array(sz);
    for(let k=0;k<sz;k++) b[k] = rnd(0,255);
    return b;
  }));

  const allASizes = aSizes.concat(fakeSizes);
  const aPad = Math.max(0, aDuration - Math.floor(movieDur * aTimeScale / movieScale) - aEdtsOff);
  const gapCalc = Math.max(0, Math.ceil(aPad/CHUNK)-1);
  const magic = 9 * totalASamples;

  const aSttsTbl = [];
  if(totalASamples-1-gapCalc > 0) aSttsTbl.push(w32(totalASamples-1-gapCalc), w32(CHUNK));
  aSttsTbl.push(w32(1), w32((gapCalc+1)*CHUNK - aPad));
  aSttsTbl.push(w32(magic), w32(1));

  const final_aStts = fbox("stts", cat([w32(aSttsTbl.length/2), cat(aSttsTbl)]));
  const final_aStsc = fbox("stsc", cat([w32(3),w32(1),w32(1),w32(1),w32(totalASamples-1),w32(2),w32(1),w32(totalASamples),w32(magic),w32(1)]));
  const zBlock = new Uint8Array(4*magic);
  for(let i=0;i<magic;i++) wp32(zBlock,4*i,8);
  const final_aStsz = fbox("stsz", cat([w32(0),w32(totalASamples+magic),cat(allASizes.map(w32)),zBlock]));
  const final_aStco = fbox("stco", cat([w32(totalASamples), new Uint8Array(4*totalASamples)]));

  const newAStbl = [box("stsd", cat([w32(0),w32(1),newAStsd])), final_aStts, final_aStsc, final_aStsz, final_aStco];
  const aSgpd = get(aSb,"sgpd"), aSbgp = get(aSb,"sbgp");
  if(aSgpd) newAStbl.push(raw(rawBuf,aSgpd));
  if(aSbgp) newAStbl.push(raw(rawBuf,aSbgp));
  const finalAStbl = box("stbl", cat(newAStbl));

  const buildMdia = (orig, mdhdOrig, pstbl) => {
    const hs = htype(rawBuf, orig);
    const hn = hs==="vide" ? "Core Media Video\0" : "Core Media Audio\0";
    const nh = box("hdlr", cat([w32(0),w32(0),s2b(hs),w32(0),w32(0),w32(0),s2b(hn)]));
    const minf = walk(orig,["mdia","minf"]);
    const mk = [];
    for(const k of minf.children) {
      if(k.type==="stbl") mk.push(pstbl);
      else if(k.type==="hdlr") {}
      else if(k.type==="vmhd") mk.push(box("vmhd", cat([w32(1),new Uint8Array(8)])));
      else if(k.type==="dinf") {
        const db = new Uint8Array(raw(rawBuf,k));
        const ap = fseq(db, s2b("alis"));
        if(ap>=0) db.set(s2b("url "), ap);
        mk.push(db);
      } else mk.push(raw(rawBuf,k));
    }
    return box("mdia", cat([raw(rawBuf, mdhdOrig), nh, box("minf", cat(mk))]));
  };

  const vMdiaF = buildMdia(vTrak, vMdhd, finalVStbl);
  const aMdiaF = buildMdia(aTrak, aMdhd, finalAStbl);

  const buildTrak = (orig, nmdia, trackId, dur) => {
    const tk = [];
    for(const k of orig.children) {
      if(k.type==="tkhd") tk.push(patchTkhd(orig, trackId, dur));
      else if(k.type==="edts"||k.type==="tapt") {}
      else if(k.type==="mdia") tk.push(nmdia);
      else tk.push(raw(rawBuf,k));
    }
    return box("trak", cat(tk));
  };

  const finalVTrak = buildTrak(vTrak, vMdiaF, 1, vDuration);
  const finalATrak = buildTrak(aTrak, aMdiaF, 2, aDuration);

  const metaBlock = (() => {
    const ilst = box("ilst", cat([
      box("©too", box("data", cat([w32(1),w32(0),s2b(ENC_TAG)]))),
      box("©cmt", box("data", cat([w32(1),w32(0),s2b("Processed by aleyxz")]))),
      box("©nam", box("data", cat([w32(1),w32(0),s2b("aleyxz")])))
    ]));
    const hdlr = box("hdlr", cat([w32(0),w32(0),s2b("mdir"),s2b("appl"),w32(0),w32(0),new Uint8Array([0])]));
    return box("udta", cat([box("meta", cat([w32(133), hdlr, ilst]))]));
  })();

  const outMoov = box("moov", cat([outMvhd, finalVTrak, finalATrak, metaBlock]));
  const outTracks = (scan(outMoov,0,outMoov.length)[0].children||[]).filter(b=>b.type==="trak");

  const findStco = tk => {
    const st = walk(tk,["mdia","minf","stbl"]); if(!st) return -1;
    const co = get(st,"stco")||get(st,"co64"); return co ? co.start : -1;
  };

  const vStcoPos = findStco(outTracks[0]);
  const aStcoPos = findStco(outTracks[1]);
  if(vStcoPos<0||aStcoPos<0) throw new Error("stco no mapeado");

  const prefix = outFtyp.length + outMoov.length;
  const mdatPayload = [];
  const vOffs = new Array(gCount);
  const aOffs = new Array(totalASamples);
  let ptr = prefix + 8;
  const maxI = Math.max(gCount, totalASamples-2);
  const empty = new Uint8Array(0);

  for(let i=0;i<maxI;i++) {
    const ac = i < totalASamples-2 ? aChunks[i] : empty;
    const vc = cat(activeG[i]||[]);
    aOffs[i] = ptr; ptr += ac.length;
    vOffs[i] = ptr; ptr += vc.length;
    mdatPayload.push(ac, vc);
  }

  aOffs[totalASamples-2] = ptr;
  const rem = cat([aChunks[totalASamples-2], aChunks[totalASamples-1]]);
  ptr += rem.length;
  mdatPayload.push(rem);
  aOffs[totalASamples-1] = ptr;

  for(let i=0;i<fakeCount;i++) ptr += fakeSizes[i];
  mdatPayload.push(fakeData);

  const finalMdat = box("mdat", cat(mdatPayload));

  for(let i=0;i<gCount;i++) wp32(outMoov, vStcoPos+16+4*i, vOffs[i]);
  for(let i=0;i<totalASamples;i++) wp32(outMoov, aStcoPos+16+4*i, aOffs[i]);

  const extraPad = new Uint8Array(magic * ZERO_BYTES.length);
  for(let i=0;i<magic;i++) extraPad.set(ZERO_BYTES, i*ZERO_BYTES.length);
  const tailJunk = new Uint8Array(rnd(80, 256));
  for(let i=0;i<tailJunk.length;i++) tailJunk[i] = rnd(0,255);

  return cat([outFtyp, outMoov, finalMdat, extraPad, tailJunk]);
}

module.exports = patchVideo;

