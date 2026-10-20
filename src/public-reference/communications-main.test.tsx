import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
it("keeps ordinary public entry, deployment policy and default clocks inert", () => {
  const app = readFileSync("src/public-reference/main.tsx", "utf8");
  expect(app).not.toContain("communications-main");expect(app).not.toContain("NativeEvidencePanel");
  const runtime = JSON.parse(readFileSync("config/platform-runtime.json", "utf8"));
  expect(JSON.stringify(runtime)).not.toContain("communication-sync-dispatch");
  expect(readFileSync("server/_lib/publicDeploymentPolicies.ts", "utf8")).toContain("adopter_policy_required");
  const vite = readFileSync("vite.public-reference.config.ts", "utf8");
  expect(vite).toContain('referenceProfile === "communications"');
  const inventory = JSON.parse(readFileSync("config/public-reference-communications-imports.json", "utf8"));
  expect(inventory.files).toContain("src/pages/admin/email-sends/NativeEvidencePanel.tsx");
});
it("mounts the selected entry and reads evidence after explicit session input",async()=>{
 const {screen,fireEvent}=await import("@testing-library/react");
 const {vi}=await import("vitest");
 document.body.innerHTML='<div id="root"></div>';
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,status:200,headers:new Headers(),json:async()=>({ok:true,data:{binding:"synthetic",candidate:"artifact",schema:"70",sends:[{id:"send",sourceKey:"source",messageId:"network:synthetic",observedState:null,abandonedAt:null}],sync:[],decisions:[]}})}));
 try{await import("./communications-main.js");
  const input=await screen.findByLabelText("Admin access token");fireEvent.change(input,{target:{value:"synthetic-session"}});fireEvent.click(screen.getByText("Inspect native evidence"));
  expect(await screen.findByText(/Accepted; delivery unobserved/)).toBeTruthy();
 }finally{vi.unstubAllGlobals();document.body.innerHTML="";}
});
