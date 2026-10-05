import {render,waitFor,cleanup,screen,act} from "@testing-library/react";
import {afterEach,it,expect,vi} from "vitest";
import {renderToString} from "react-dom/server";
import {AccessBootstrap} from "@/features/report/access-bootstrap";
const reload=vi.fn();
function mockReload(){
 const original=window;
 const location={get pathname(){return original.location.pathname;},get search(){return original.location.search;},get hash(){return original.location.hash;},reload};
 vi.stubGlobal("window",new Proxy(original,{get(target,key){return key === "location" ? location : Reflect.get(target,key,target);}}));
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();window.history.replaceState(null,"","/");});
it("removes the private fragment only after successful cookie exchange",async()=>{
 window.history.replaceState(null,"","/en/r/report#access=private-token");mockReload();
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true}));render(<AccessBootstrap publicId="report" />);
 await waitFor(()=>expect(reload).toHaveBeenCalled());expect(window.location.hash).toBe("");
});
it("keeps the original token link when exchange fails so reload can retry",async()=>{
 window.history.replaceState(null,"","/en/r/report#access=private-token");mockReload();
 const fetch=vi.fn().mockResolvedValue({ok:false});vi.stubGlobal("fetch",fetch);render(<AccessBootstrap publicId="report" />);
 await waitFor(()=>expect(fetch).toHaveBeenCalled());expect(window.location.hash).toBe("#access=private-token");expect(reload).not.toHaveBeenCalled();
});

function boundary() {
 return <AccessBootstrap publicId="report" pending={<p>Opening report</p>} unavailable={<p>Report unavailable</p>}><p>Private access required</p></AccessBootstrap>;
}
it("shows opening state through a successful first-visit exchange without denial",async()=>{
 window.history.replaceState(null,"","/en/r/report#access=private-token");mockReload();
 let resolve!: (value: Response) => void;
 vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));
 render(boundary());
 expect(screen.getByText("Opening report")).toBeInTheDocument();
 expect(screen.queryByText("Private access required")).not.toBeInTheDocument();
 await act(async()=>resolve(new Response(null,{status:200})));
 expect(reload).toHaveBeenCalled();
 expect(screen.queryByText("Private access required")).not.toBeInTheDocument();
});
it("shows denial when the link has no private token",async()=>{
 render(boundary());
 expect(await screen.findByText("Private access required")).toBeInTheDocument();
});
it("shows denial after an invalid token is rejected",async()=>{
 window.history.replaceState(null,"","/#access=invalid");
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(null,{status:401})));
 render(boundary());
 expect(await screen.findByText("Private access required")).toBeInTheDocument();
});
it.each(["network","server"])("shows unavailable after %s exchange failure",async(kind)=>{
 window.history.replaceState(null,"","/#access=private-token");
 vi.stubGlobal("fetch",kind==="network"?vi.fn().mockRejectedValue(new Error("offline")):vi.fn().mockResolvedValue(new Response(null,{status:503})));
 render(boundary());
 expect(await screen.findByText("Report unavailable")).toBeInTheDocument();
 expect(window.location.hash).toBe("#access=private-token");
 expect(reload).not.toHaveBeenCalled();
});

it("server renders opening state before the browser can inspect the fragment",()=>{
 const html=renderToString(boundary());
 expect(html).toContain("Opening report");
 expect(html).not.toContain("Private access required");
});
