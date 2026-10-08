const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

async function apiTests() {
  let connected = 0;
  const sandbox = {
    module: { exports: {} }, process: { env: {} }, console,
    require(name) {
      if (name === "mongodb") return { MongoClient: class {
        async connect() { connected++; }
        db() { return { collection() { return { findOne: async () => ({ state: { test: true } }) }; } }; }
      } };
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "api/state.js"), "utf8"), sandbox);
  const call = async (headers = {}, method = "GET") => {
    const result = { headers: {} };
    const res = { setHeader(k,v) { result.headers[k]=v; }, status(c) { result.code=c;return this; }, json(b) { result.body=b; }, end() {} };
    await sandbox.module.exports({headers,method,socket:{remoteAddress:"test-client"}},res);
    return result;
  };
  assert.equal((await call()).code,503);
  sandbox.process.env.DASHBOARD_SYNC_KEY="   ";
  assert.equal((await call()).code,503);
  assert.equal(connected,0);
  sandbox.process.env.DASHBOARD_SYNC_KEY="test-only-secret";
  sandbox.process.env.MONGODB_URI="test-only-uri";
  for(let i=0;i<10;i++)assert.equal((await call()).code,401);
  assert.equal((await call()).code,429);
  assert.equal(connected,0);
  const valid=await call({"x-dashboard-key":"test-only-secret","x-vercel-forwarded-for":"different-test-client"});
  assert.equal(valid.code,200);
  assert.equal(valid.headers["Cache-Control"],"private, no-store");
  assert.equal((await call({},"DELETE")).code,405);
  console.log("PASS: fail closed, invalid key, attempt limit, valid auth, cache control, methods");
}

async function browserTests() {
  const { chromium }=require(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser=await chromium.launch({channel:"chrome",headless:true});
  const month=(revenue,status)=>({manual:{"rev:혜진":revenue,rev_total:revenue},extras:[],memo:"test only",status,closedAt:1,updatedAt:1});
  let state={months:{},close:{"2026-08":month(100,"completed"),"2026-09":month(200,"completed"),"2026-10":month(300,"draft")},cfg:{designers:["건한","근영","혜진"],defaults:{}},inventory:[],inventoryDataVersion:3,syncRevision:"test-initial"};
  let failWrites=false;
  const errors=[], contexts=[];
  async function device(mobile=false) {
    const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},acceptDownloads:true});
    contexts.push(context);
    await context.addInitScript(()=>{localStorage.setItem("nudif-sync-key","test-only-secret");localStorage.setItem("nudif-mongodb-migration-v1","done");});
    await context.route("https://**/*",async route=>{
      if(!route.request().url().endsWith("/api/state"))return route.abort();
      if(route.request().method()==="PUT"){
        if(failWrites)return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"test storage failure"})});
        state=route.request().postDataJSON().state;
        return route.fulfill({status:200,contentType:"application/json",body:'{"ok":true}'});
      }
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({state})});
    });
    const page=await context.newPage();
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto("file://"+path.join(root,"index.html")+"#home");
    await page.waitForFunction(()=>cloudConnected);
    return page;
  }
  try {
    const phone=await device(true),pc=await device();
    assert.equal(await pc.evaluate(()=>latestClosedKey()),"2026-09");
    assert((await pc.locator("#homeDate").textContent()).includes("9월"));
    assert.equal(await pc.evaluate(()=>document.querySelectorAll("#designerTrend circle").length),2);
    const original=JSON.stringify(state.close["2026-10"].manual);
    await phone.evaluate(()=>{cCur={y:2026,m:10};renderClose(false);});
    await phone.evaluate(()=>$("cSave").onclick());
    assert.equal(state.close["2026-10"].status,"completed");
    await pc.reload();await pc.waitForFunction(()=>cloudConnected);
    assert.equal(await pc.evaluate(()=>latestClosedKey()),"2026-10");
    assert.equal(await pc.evaluate(()=>document.querySelectorAll("#designerTrend circle").length),3);
    await phone.evaluate(()=>$("cancelConfirm").onclick());
    assert.equal(state.close["2026-10"].status,"draft");
    assert.equal(JSON.stringify(state.close["2026-10"].manual),original);
    await pc.reload();await pc.waitForFunction(()=>cloudConnected);
    assert.equal(await pc.evaluate(()=>latestClosedKey()),"2026-09");
    assert.equal(await pc.evaluate(()=>document.querySelectorAll("#designerTrend circle").length),2);
    await phone.evaluate(()=>$("cSave").onclick());
    assert.equal(state.close["2026-10"].status,"completed");
    failWrites=true;
    await phone.evaluate(()=>{closeEditing=true;draft.manual["rev:혜진"]=999;return $("cSave").onclick();});
    assert.equal(state.close["2026-10"].manual["rev:혜진"],300);
    assert((await phone.locator("#cStatus").textContent()).includes("저장하지 못했습니다"));
    assert.equal(await phone.evaluate(()=>cloudConnected),false);
    failWrites=false;
    const before=JSON.stringify(state);
    const downloaded=pc.waitForEvent("download");
    await pc.evaluate(()=>$("downloadBackup").onclick());
    const download=await downloaded,stream=await download.createReadStream(),chunks=[];
    for await(const chunk of stream)chunks.push(chunk);
    const backup=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(backup.format,"nudif-backup-v1");
    assert.equal(JSON.stringify(backup.state),before);
    assert.equal(JSON.stringify(state),before);
    assert(!JSON.stringify(backup).includes("test-only-secret"));
    // Validate restoring into an isolated empty browser, never the live database.
    await pc.evaluate(s=>{applyServerState(s);renderDesigners();},backup.state);
    assert.equal(await pc.evaluate(()=>latestClosedKey()),"2026-10");
    assert.equal(await pc.evaluate(()=>savedDesignerRevenue("2026-08","혜진")),100);
    assert.deepEqual(errors,[]);
    console.log("PASS: two isolated devices, complete/cancel/recomplete, amounts preserved, graphs, failed save, backup round-trip");
  } finally {await browser.close();}
}
apiTests().then(browserTests).catch(e=>{console.error(e);process.exitCode=1;});
