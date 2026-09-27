import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

type Event = Record<string, any>;

function parseArgs() {
  const args=process.argv.slice(2);
  let turns=1;
  let fixture=process.env.SPARK_REALTIME_FIXTURE || path.resolve('runtime/benchmarks/spark/fixtures/speech-short.wav');
  for(let i=0;i<args.length;i++){
    if(args[i]==='--turns') turns=Number(args[++i]);
    else if(args[i]==='--fixture') fixture=args[++i];
  }
  return {turns,fixture};
}

function wavPcm(file: string): { pcm: Buffer; rate: number } {
  const b=fs.readFileSync(file);
  assert.equal(b.toString('ascii',0,4),'RIFF');
  assert.equal(b.toString('ascii',8,12),'WAVE');
  let off=12,rate=0,channels=0,bits=0,data:Buffer|undefined;
  while(off+8<=b.length){
    const id=b.toString('ascii',off,off+4), size=b.readUInt32LE(off+4), start=off+8;
    if(id==='fmt '){ channels=b.readUInt16LE(start+2); rate=b.readUInt32LE(start+4); bits=b.readUInt16LE(start+14); }
    if(id==='data'){ data=b.subarray(start,start+size); break; }
    off=start+size+(size%2);
  }
  assert.ok(data); assert.equal(channels,1); assert.equal(bits,16); assert.ok(rate>0);
  return {pcm:data,rate};
}

function resample(pcm: Buffer, from: number, to=24000): Buffer {
  if(from===to) return pcm;
  const input=pcm.length/2, output=Math.floor(input*to/from), out=Buffer.alloc(output*2);
  for(let i=0;i<output;i++){
    const src=Math.min(input-1,Math.floor(i*from/to));
    out.writeInt16LE(pcm.readInt16LE(src*2),i*2);
  }
  return out;
}

class Queue {
  private items: Event[]=[]; private waiters: Array<(e:Event)=>void>=[];
  push(e:Event){ const w=this.waiters.shift(); if(w) w(e); else this.items.push(e); }
  async next(type:string,timeout=180000):Promise<Event>{
    const existing=this.items.findIndex((x)=>x.type===type);
    if(existing>=0) return this.items.splice(existing,1)[0];
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      const e=await new Promise<Event>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`timeout waiting ${type}`)),Math.min(1000,deadline-Date.now()));
        this.waiters.push((v)=>{clearTimeout(timer);resolve(v);});
      }).catch(()=>undefined);
      if(e){
        if(e.type===type) return e;
        this.items.push(e);
      }
    }
    throw new Error(`timeout waiting ${type}`);
  }
}

const {turns,fixture}=parseArgs();
const {pcm:raw,rate}=wavPcm(fixture);
const pcm=resample(raw,rate);
const url=process.env.STEPAUDIO2_LOCAL_WS_URL || 'ws://127.0.0.1:8092/realtime';
const ws=new WebSocket(url);
const q=new Queue();
ws.on('message',(raw)=>q.push(JSON.parse(raw.toString())));
await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
ws.send(JSON.stringify({type:'session.update',session:{instructions:'You are a concise memoir interviewer.',turn_detection:null}}));
const caps=await q.next('session.capabilities',10000);
assert.equal(caps.capabilities.fullDuplex,false);
assert.equal(caps.capabilities.supportsInterrupt,false);
await q.next('session.updated',10000);

const metrics=[];
for(let turn=0;turn<turns;turn++){
  for(let off=0;off<pcm.length;off+=960){
    ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:pcm.subarray(off,off+960).toString('base64')}));
  }
  const commitAt=performance.now();
  ws.send(JSON.stringify({type:'input_audio_buffer.commit'}));
  const transcript=await q.next('conversation.item.input_audio_transcription.completed');
  const asrMs=performance.now()-commitAt;
  assert.ok(String(transcript.transcript||'').trim().length>0,'ASR returned empty transcript');
  const responseAt=performance.now();
  ws.send(JSON.stringify({type:'response.create',response:{modalities:['text','audio']}}));
  let firstAudioMs:number|undefined, audioChunks=0;
  while(true){
    const e=await Promise.race([
      q.next('response.audio.delta').then((x)=>({kind:'audio',e:x})),
      q.next('response.done').then((x)=>({kind:'done',e:x})),
    ]);
    if(e.kind==='audio'){
      if(firstAudioMs===undefined) firstAudioMs=performance.now()-responseAt;
      audioChunks++;
      continue;
    }
    break;
  }
  assert.ok(firstAudioMs!==undefined && audioChunks>0,'no streamed audio received');
  metrics.push({turn:turn+1,asr_ms:Math.round(asrMs),first_audio_ms:Math.round(firstAudioMs),total_response_ms:Math.round(performance.now()-responseAt),audio_chunks:audioChunks});
}
ws.send(JSON.stringify({type:'session.close'}));
await q.next('session.closed',5000);
ws.close();
console.log(JSON.stringify({status:'PASS',fixture:path.basename(fixture),turns,metrics}));
