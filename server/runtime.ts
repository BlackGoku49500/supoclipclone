import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";

export const dataRoot=path.resolve(process.env.SUPO_DATA_DIR || "./data");
export const python=process.env.PYTHON_BIN || "python3";
export const workerRoot=path.join(process.cwd(),"worker");
export const demoRoot=path.join(process.cwd(),"public","demo");
export const ttlMs=24*60*60*1000;
export class HttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}
export function uniqueId(){return randomUUID();}
export function checkId(value:unknown): string {
  if(typeof value!=="string" || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) throw new HttpError(404,"This item could not be found.");
  return value;
}
export async function readJson<T>(filename:string):Promise<T>{
  try{return JSON.parse(await readFile(filename,"utf8")) as T;}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")throw new HttpError(404,"This item has expired or belongs to another session.");throw e;}
}
export async function writeJson(filename:string,value:unknown){
  await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  const tmp=filename+"."+uniqueId()+".tmp";
  await writeFile(tmp,JSON.stringify(value),{mode:0o600});
  await rename(tmp,filename);
}
export function abortError(){return new HttpError(499,"Operation cancelled.");}
export function run(command:string,args:string[],options:{signal?:AbortSignal;timeout?:number;maxBytes?:number;cwd?:string}={}):Promise<string>{
  const {signal,timeout=120_000,maxBytes=16*1024*1024,cwd}=options;
  if(signal?.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,shell:false,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"],env:{...process.env,PYTHONUNBUFFERED:"1"}});
    const chunks:Buffer[]=[];
    let total=0,stderr="",failure:Error|undefined,settled=false;
    let escalation:NodeJS.Timeout|undefined;
    const kill=(sig:NodeJS.Signals)=>{
      if(!child.pid)return;
      try{if(process.platform!=="win32")process.kill(-child.pid,sig);else child.kill(sig);}catch{/* Already exited. */}
    };
    const stop=(error:Error)=>{
      if(failure)return;
      failure=error;kill("SIGTERM");
      escalation=setTimeout(()=>kill("SIGKILL"),1500);
    };
    const aborted=()=>stop(abortError());
    const timer=setTimeout(()=>stop(new HttpError(504,"The media task timed out. Try a shorter source or retry this clip.")),timeout);
    const finish=(err?:Error)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);clearTimeout(escalation);signal?.removeEventListener("abort",aborted);
      if(err)reject(err);else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    signal?.addEventListener("abort",aborted,{once:true});
    child.stdout.on("data",(chunk:Buffer)=>{total+=chunk.length;if(total<=maxBytes)chunks.push(chunk);else stop(new HttpError(413,"The media tool returned too much metadata."));});
    child.stderr.on("data",(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-16000);});
    child.on("error",()=>finish(new HttpError(503,"A required media tool could not start. Check the Python, yt-dlp and FFmpeg installation.")));
    child.on("close",(code)=>{
      if(failure)return finish(failure);
      if(code!==0){
        const clean=stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ").replace(/https?:\/\/\S+/gi,"[media URL]").replace(/sk-or-[\w-]+/gi,"[redacted]").slice(0,480);
        return finish(new HttpError(422,clean || "The media provider could not process this source."));
      }
      finish();
    });
  });
}
export function worker(name:"ingest"|"render"|"transcribe",args:string[],signal?:AbortSignal,timeout=120_000){
  return run(python,[path.join(workerRoot,name+".py"),...args],{signal,timeout});
}
