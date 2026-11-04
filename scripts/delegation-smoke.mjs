// Opt-in trial with real local models. Only creates goals through the product;
// owner creation, work and delivery must be performed by the concierge/owners.
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const trial = await realpath(await mkdtemp("/tmp/cv-delegate-"));
const workspace = join(trial, "workspace"), home = join(trial, "home");
const session = `crewvane-trial-${randomUUID().slice(0, 8)}`;
await mkdir(workspace); await mkdir(home);
await writeFile(join(workspace, "AGENTS.md"), `# 隔离产品验收
只处理本工作区目标，不访问其他项目或用户文件，不提交、发布或发送外部消息。
目标实际执行必须由独立负责人完成，管家只负责分发、协调与向人交接。
交付检查必须实际运行，不得编造。负责人须记录自己真实的 HERDR_PANE_ID。
`);
let app, page;
const errors = [];
async function snapshot() { return page.evaluate(() => window.crewvane.command({type:"snapshot"})); }
async function capture(label) {
  const current = await snapshot();
  await writeFile(join(trial, `${label}-state.json`), JSON.stringify(current, null, 2));
  const diagnostics = await app.evaluate(async (_electron, session) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    const run = args => new Promise(resolve => execFile("herdr", ["--session", session, ...args],
      {timeout:10_000,maxBuffer:512_000}, (error, stdout, stderr) => resolve({error:error?.message,stdout,stderr})));
    const listed = await run(["agent","list"]);
    let entries = [];
    try { const data = JSON.parse(listed.stdout); entries = data.result?.agents ?? data.agents ?? []; } catch {}
    return { listed, transcripts: await Promise.all(entries.map(async agent => ({
      name:agent.name, paneId:agent.pane_id,
      read:await run(["agent","read",agent.name || agent.pane_id,"--source","visible","--lines","40"]),
    }))) };
  }, session);
  await writeFile(join(trial, `${label}-agents.json`), JSON.stringify(diagnostics, null, 2));
  await page.screenshot({path:join(trial,`${label}.png`),animations:"disabled"});
  return diagnostics;
}
try {
  app = await electron.launch({
    executablePath:resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:{...process.env,CREWVANE_TEST_HOME:home,CREWVANE_TEST_USER_DATA:join(trial,"userData"),
      CREWVANE_TEST_WORKSPACE:workspace,CREWVANE_HERDR_SESSION:session},
    timeout:60_000,
  });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await expect.poll(async () => (await page.evaluate(() => window.crewvane.environment())).workspace).toBe(workspace);
  const ids = [];
  for (const marker of ["ALPHA_READY","BETA_READY"]) {
    const goal = await page.evaluate(({marker,workspace}) => window.crewvane.command({type:"goal.create",input:{
      title:`交付 ${marker}`,projectId:"personal",mode:"concierge",
      description:`在 ${workspace}/${marker}.json 写入 JSON，包含 marker="${marker}" 和 executorPane（执行者进程环境中的真实 HERDR_PANE_ID）。实际运行一个读取此文件并断言 marker 与非空 executorPane 的命令，再提交成果位置和真实检查记录供我验收。不要只回复文字。只操作此隔离工作区，无需提交或发布。`,
    }}),{marker,workspace});
    ids.push(goal.id);
  }
  console.log(JSON.stringify({step:"two-goals-created",trial,session,ids}));
  const start = Date.now();
  let inspected = 0, current;
  while (Date.now() - start < 600_000) {
    current = await snapshot();
    const selected = current.goals.filter(goal => ids.includes(goal.id));
    if (selected.every(goal => goal.status === "review")) break;
    if (Math.floor((Date.now()-start)/60_000) > inspected) {
      inspected++;
      await capture(`minute-${inspected}`);
      console.log(JSON.stringify({step:"waiting",minute:inspected,goals:selected.map(goal=>({
        id:goal.id,status:goal.status,dispatch:goal.dispatch?.status,pane:goal.herdr?.paneId,
        question:goal.attention?.summary,
      }))}));
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const goals = current.goals.filter(goal=>ids.includes(goal.id));
  assert.ok(goals.every(goal=>goal.status==="review"),"both goals must reach review through real owners");
  assert.equal(new Set(goals.map(goal=>goal.herdr?.paneId)).size,2,"each goal has a distinct owner pane");
  for (const [index,marker] of ["ALPHA_READY","BETA_READY"].entries()) {
    const goal = goals.find(goal=>goal.id===ids[index]);
    assert.ok(goal.herdr?.paneId && goal.herdr?.tabId && goal.herdr?.agent);
    assert.equal(goal.herdr.session,session);
    assert.notEqual(goal.herdr.paneId,current.concierge.paneId);
    assert.notEqual(goal.herdr.tabId,current.concierge.tabId);
    const delivered = JSON.parse(await readFile(join(workspace,`${marker}.json`),"utf8"));
    assert.equal(delivered.marker,marker);
    assert.equal(delivered.executorPane,goal.herdr.paneId,"the actual executor is the registered owner, not concierge");
    assert.ok(goal.delivery.checks.length && goal.delivery.checks.every(check=>check.result==="passed"));
  }
  await page.evaluate(()=>window.crewvane.openTerminal());
  await page.getByRole("region",{name:"Herdr 工作现场"}).waitFor();
  const diagnostics = await capture("two-real-owners");
  const data = JSON.parse(diagnostics.listed.stdout), agents = data.result?.agents ?? data.agents;
  assert.equal(agents.length,3,"two goals have exactly two owners and one concierge, without duplicate starts");
  assert.equal(agents.filter(agent=>agent.name==="concierge").length,1);
  assert.ok(goals.every(goal=>agents.some(agent=>agent.pane_id===goal.herdr.paneId)));
  await app.close();
  app = await electron.launch({
    executablePath:resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:{...process.env,CREWVANE_TEST_HOME:home,CREWVANE_TEST_USER_DATA:join(trial,"userData"),
      CREWVANE_TEST_WORKSPACE:workspace,CREWVANE_HERDR_SESSION:session},timeout:60_000,
  });
  page = await app.firstWindow();
  page.on("pageerror",error=>errors.push(String(error)));
  await expect.poll(async()=> (await page.evaluate(()=>window.crewvane.environment())).workspace).toBe(workspace);
  await page.evaluate(()=>window.crewvane.prepareConcierge());
  const restored = await snapshot();
  assert.equal(restored.concierge.paneId,current.concierge.paneId,"resuming refreshes the existing concierge without replacing it");
  assert.deepEqual(restored.goals.filter(goal=>ids.includes(goal.id)).map(goal=>goal.herdr),goals.map(goal=>goal.herdr));
  const resumed=await capture("resumed-roles");
  const resumedData=JSON.parse(resumed.listed.stdout);
  assert.equal((resumedData.result?.agents ?? resumedData.agents).length,3);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,trial,session,checks:[
    "two desktop goals create two independent real owners","one global concierge",
    "actual outputs identify each owner pane","real checks and delivery","restart refreshes concierge role and preserves both owner references",
  ]}));
} catch (error) {
  if (app && page) await capture("failure").catch(()=>{});
  console.error(JSON.stringify({trial,session,error:String(error),errors}));
  throw error;
} finally {
  if (app) {
    await app.evaluate(async(_electron,session)=>{
      const {execFile}=process.getBuiltinModule("node:child_process");
      await new Promise(resolve=>execFile("herdr",["--session",session,"server","stop"],{timeout:10_000},()=>resolve()));
    },session).catch(()=>{});
    await app.close().catch(()=>{});
  }
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS!=="1") await rm(trial,{recursive:true,force:true});
}
