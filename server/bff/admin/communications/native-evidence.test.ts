import {expect,it,vi} from "vitest";
import {createNativeEvidenceHandler} from "./native-evidence.js";
it("refuses an unverified actor before native storage and sanitizes unavailable readback",async()=>{
 const res={status:vi.fn(),json:vi.fn(),setHeader:vi.fn(),end:vi.fn()};res.status.mockReturnValue(res);
 const handler=createNativeEvidenceHandler({env:{PLATFORM_BUNDLE:"node-postgres"},authorize:async()=>null});
 await handler({method:"GET",headers:{},body:{principalId:"untrusted"}} as never,res as never);
 expect(res.status).toHaveBeenCalledWith(401);
 const unavailable=createNativeEvidenceHandler({env:{PLATFORM_BUNDLE:"node-postgres"},authorize:async()=>"verified-admin"});
 await unavailable({method:"GET",headers:{}} as never,res as never);expect(res.status).toHaveBeenLastCalledWith(503);
 expect(JSON.stringify(res.json.mock.calls)).not.toContain("database_url");
});
