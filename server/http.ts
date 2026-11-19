import {NextRequest, NextResponse} from "next/server";
import {createHash,randomBytes} from "node:crypto";
import {HttpError} from "./runtime";

export type Session={owner:string; cookie?:string};
export function session(req:NextRequest,create=false):Session{
  let token=req.cookies.get("supo_session")?.value;
  let cookie:string|undefined;
  if(!token || !/^[\da-f]{64}$/.test(token)){
    if(!create)throw new HttpError(404,"Your workspace has expired. Open a source to start again.");
    token=randomBytes(32).toString("hex");cookie=token;
  }
  return {owner:createHash("sha256").update(token).digest("hex"),cookie};
}
export function response(req:NextRequest,data:unknown,s?:Session,status=200){
  const res=NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  if(s?.cookie){
    const secure=req.nextUrl.protocol==="https:"||req.headers.get("x-forwarded-proto")==="https";
    res.cookies.set("supo_session",s.cookie,{httpOnly:true,sameSite:secure?"none":"lax",secure,partitioned:secure,path:"/",maxAge:86400});
  }
  return res;
}
export async function guard(req:NextRequest,doWork:()=>Promise<Response>):Promise<Response>{
  try{
    if(req.method!=="GET" && req.method!=="HEAD"){
      const site=req.headers.get("sec-fetch-site");
      const origin=req.headers.get("origin");
      if(site==="cross-site" || (origin && new URL(origin).host!==(req.headers.get("x-forwarded-host")||req.headers.get("host"))?.split(",")[0].trim()))throw new HttpError(403,"Open the studio on this host to make changes.");
    }
    return await doWork();
  }catch(e){
    if(e instanceof HttpError)return response(req,{error:e.message},undefined,e.status);
    if(e instanceof DOMException && e.name==="AbortError")return response(req,{error:"Operation cancelled."},undefined,499);
    return response(req,{error:"The studio could not complete this request. Check the server and retry."},undefined,500);
  }
}
export async function json(req:NextRequest,limit=4*1024*1024):Promise<Record<string,unknown>>{
  if(!req.headers.get("content-type")?.includes("application/json"))throw new HttpError(415,"Send an application/json request.");
  if(Number(req.headers.get("content-length"))>limit)throw new HttpError(413,"This request is too large.");
  const reader=req.body?.getReader();
  if(!reader)throw new HttpError(400,"A request body is required.");
  const parts:Uint8Array[]=[];let size=0;
  try{for(;;){
    const result=await reader.read();if(result.done)break;
    size+=result.value.length;if(size>limit){await reader.cancel();throw new HttpError(413,"This request is too large.");}
    parts.push(result.value);
  }}finally{reader.releaseLock();}
  try{const value=JSON.parse(Buffer.concat(parts).toString("utf8"));if(!value || typeof value!=="object" || Array.isArray(value))throw Error();return value;}
  catch{throw new HttpError(400,"Send a valid JSON object.");}
}
