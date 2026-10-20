import { useEffect, useState } from "react";
import { getNativeEvidence } from "../../../domains/communications/nativeEvidenceClient.js";
import type { NativeEvidence } from "../../../domains/communications/nativeEvidenceContracts.js";
export function NativeEvidencePanel({accessToken,load=getNativeEvidence}:{accessToken?:string;load?:(token:string,signal?:AbortSignal)=>Promise<NativeEvidence>}) {
 const [data,setData]=useState<NativeEvidence|null>(null),[error,setError]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{
  setData(null);setError(false);
  if(!accessToken)return;
  const controller=new AbortController();
  void load(accessToken,controller.signal).then(value=>{if(!controller.signal.aborted)setData(value);},()=>{if(!controller.signal.aborted)setError(true);});
  return ()=>controller.abort();
 },[accessToken,load,revision]);
 return <section aria-label="Native communications evidence">
  <h2>Native communications evidence</h2>
  <p>Accepted network references, membership work and consent decisions. Managed history appears separately.</p>
  <button disabled={!accessToken} onClick={()=>setRevision(value=>value+1)}>Refresh native evidence</button>
  {!accessToken?<p>Admin session required</p>:error?<p role="alert">Native evidence unavailable</p>:!data?<p>Loading native evidence…</p>:<>
   <p>Binding {data.binding}; candidate {data.candidate}; schema {data.schema}</p>
   {data.sends.length===0&&<p>No native network references</p>}
   <ul>{data.sends.map(send=><li key={send.id}>{send.sourceKey} · {send.messageId} · {send.observedState===null?(send.abandonedAt?"Abandoned; delivery unknown":"Accepted; delivery unobserved"):`Observed ${send.observedState}`}</li>)}</ul>
   <ul>{data.sync.map(work=><li key={work.id}>Membership {work.status} · {work.id}</li>)}</ul>
   <p>Consent decisions below are installation scoped snapshots, not send-time fences. Managed frequency caps and legacy contact-touching are excluded.</p>
   <ul>{data.decisions.map(decision=><li key={decision.id}>{decision.allowed?"Allowed":"Blocked"}: {decision.reason} · {decision.id}</li>)}</ul>
  </>}
 </section>;
}
