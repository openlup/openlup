import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NativeEvidencePanel } from "../pages/admin/email-sends/NativeEvidencePanel.js";
/** Disposable opt-in UI. An existing verified admin session is required by the mounted API. */
export function CommunicationsReference() {
 const [draft,setDraft]=useState(""),[token,setToken]=useState("");
 return <main><h1>Communications reference</h1><form onSubmit={event=>{event.preventDefault();setToken(draft);setDraft("");}}>
 <label>Admin access token <input type="password" autoComplete="off" value={draft} onChange={event=>setDraft(event.target.value)}/></label><button>Inspect native evidence</button></form>
 <NativeEvidencePanel accessToken={token}/></main>;
}
const root=document.getElementById("root");if(!root)throw new Error("Communications reference root missing");
createRoot(root).render(<CommunicationsReference/>);
