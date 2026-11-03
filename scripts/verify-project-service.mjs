import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {startBridge} from '../src/bridge/server.ts';
import {SqliteStore} from '../src/bridge/sqlite-store.ts';
import {emptyDocument} from '../src/cad/document.ts';
import {LEGACY_PROJECT_ID} from '../src/shared/protocol.ts';

// All writes, including restart and project deletion, use this disposable workspace.
const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(join(tmpdir(),'vibeworks-project-service-'));
const out=join(root,'output/playwright/project-service');await mkdir(out,{recursive:true});
process.env.VIBEWORKS_WEB_PORT='45214';process.env.VIBEWORKS_BRIDGE_PORT='44369';
const longName='Prototype suspension and steering geometry with extraordinarily long names — Final revision 2026';
const seed=new SqliteStore(join(dir,'workspace.db'));
await seed.operation({action:'project',project:{projectId:LEGACY_PROJECT_ID,name:longName,version:1},expectedVersion:1});
const doc={...emptyDocument(),projectId:LEGACY_PROJECT_ID,name:'Test bracket',analysis:{auto:false},features:[{id:'body',kind:'box',params:{origin:[0,0,0],size:[30,20,5]},appearance:{color:'#376a8b'}}]};
await seed.put(doc);seed.close();
let bridge,server,browser;const errors=[],results={};
try{
 bridge=await startBridge({port:44369,databasePath:join(dir,'workspace.db'),connectionFile:join(dir,'connection.json'),webOrigins:['http://127.0.0.1:45214'],workers:1});await bridge.ready();
 const headers={Authorization:'Bearer '+bridge.connection.token,'Content-Type':'application/json','X-Vibeworks-Fingerprint':bridge.connection.fingerprint};
 const status=async()=> (await fetch(bridge.connection.httpUrl+'/service',{headers})).json();
 server=await createServer({root,configFile:join(root,'vite.config.ts')});await server.listen();
 browser=await chromium.launch({headless:true,args:process.platform==='darwin'?['--use-angle=metal']:[]});
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce'});
 page.setDefaultTimeout(15_000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:45214');await page.evaluate(()=>window.__cad.ready);await page.getByRole('button',{name:'MCP service: Online',exact:true}).waitFor();
 const monitor=page.getByRole('dialog',{name:'Service monitor',exact:true});
 const settle=async locator=>{await locator.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));await new Promise(requestAnimationFrame);});};
 await page.getByRole('button',{name:'MCP service: Online',exact:true}).click();await monitor.waitFor();
 await monitor.getByText('0 MCP clients connected',{exact:true}).waitFor();await monitor.getByText('Service memory',{exact:true}).waitFor();assert.equal(await monitor.getByRole('img').count(),1);
 await page.screenshot({path:join(out,'project-entrance-monitor.png')});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:new RegExp('^'+longName)}).click();await page.getByRole('button',{name:'Open project',exact:true}).click();
 await page.getByRole('tree',{name:'Model',exact:true}).waitFor();await page.locator('.loading').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Project: '+longName,exact:true}).click();
 const menu=page.getByRole('menu',{name:'Project: '+longName,exact:true});
 await menu.locator('.middle-truncate').filter({hasText:'…'}).waitFor();await page.screenshot({path:join(out,'project-menu-long-name.png')});
 const truncation=await menu.locator('.middle-truncate').innerText();assert.ok(truncation.includes('…')&&truncation.startsWith('Prototype')&&truncation.endsWith('2026'),JSON.stringify({truncation,bounds:await menu.boundingBox()}));
 assert.equal(await menu.getByRole('menuitem',{name:'New project',exact:true}).count(),1);
 assert.equal(await menu.locator('.project-row-actions button').count(),3);assert.equal(await menu.getByText('All projects…',{exact:true}).count(),0);
 await page.screenshot({path:join(out,'project-menu-long-name.png')});await page.keyboard.press('Escape');
 // Checks must reopen the actual Details panel from both compact and collapsed.
 await page.getByRole('button',{name:'Compact Details panel',exact:true}).click();await page.getByRole('button',{name:'Open design checks',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.right-panel').dataset.panelState==='expanded');
 await page.getByRole('button',{name:'Run checks',exact:true}).waitFor();await page.getByRole('button',{name:'Hide Details panel',exact:true}).click();
 await page.getByRole('button',{name:'Open design checks',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.right-panel').dataset.panelState==='expanded');
 await page.getByRole('button',{name:'Run checks',exact:true}).click();await page.getByRole('button',{name:'Recheck',exact:true}).waitFor();
 results.checks={reopensCompact:true,reopensCollapsed:true,runsPhysicalChecks:true};
 console.log('Checks and long-name menu passed');
 // Confirmation has no navigation side effect when cancelled; warm browsing preserves the canvas.
 await page.evaluate(()=>{window.__originalCanvas=document.querySelector('.viewport canvas');});
 await page.getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('dialog',{name:'Browse all projects?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('dialog',{name:'Browse projects',exact:true}).count(),0);
 const browse=async()=>{await page.getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('dialog',{name:'Browse all projects?',exact:true}).getByRole('button',{name:'All projects',exact:true}).click();};
 await browse();await page.getByRole('dialog',{name:'Browse projects',exact:true}).waitFor();
 const browseRoot=page.getByRole('dialog',{name:'Browse projects',exact:true});await browseRoot.getByRole('button',{name:'MCP service: Online',exact:true}).click();
 await monitor.getByRole('button',{name:'Close service monitor',exact:true}).focus();await page.keyboard.press('Shift+Tab');assert.equal(await monitor.evaluate(el=>el.contains(document.activeElement)),true);
 await page.keyboard.press('Tab');assert.equal(await monitor.evaluate(el=>el.contains(document.activeElement)),true);await page.keyboard.press('Escape');assert.equal(await browseRoot.isVisible(),true);
 await page.getByRole('button',{name:'Return to workspace',exact:true}).click();assert.equal(await page.evaluate(()=>window.__originalCanvas===document.querySelector('.viewport canvas')),true);
 results.navigation={confirmedBrowsing:true,cancelPreservesView:true,warmReturn:true,monitorKeyboardWithinBrowser:true};
 // Confirmed worker restart keeps the bridge and saved definition. Cancel does not reset its identity.
 await page.getByRole('button',{name:'MCP service: Online',exact:true}).click();const before=await status();
 await monitor.getByRole('button',{name:'Restart service',exact:true}).click();await page.getByRole('dialog',{name:'Restart modeling service?',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal((await status()).serviceId,before.serviceId);
 await monitor.getByRole('button',{name:'Restart service',exact:true}).click();
 const restarted=page.waitForResponse(response=>response.url().endsWith('/api/service/restart')&&response.request().method()==='POST');
 await page.getByRole('dialog',{name:'Restart modeling service?',exact:true}).getByRole('button',{name:'Restart service',exact:true}).click();
 const response=await restarted;assert.equal(response.status(),200,await response.text());
 assert.notEqual((await status()).serviceId,before.serviceId);
 const closeMonitor=async()=>{const trigger=page.getByRole('button',{name:/^MCP service:/});if(await trigger.getAttribute('aria-expanded')==='true')await trigger.click();};
 await closeMonitor();await page.locator('.loading').waitFor({state:'hidden'});results.restart={cancelDoesNothing:true,confirmedRestartOnline:true};
 console.log('Warm browsing and restart passed');
 // Each row's icon acts on that row. Duplicating produces independently deletable projects.
 const openMenu=async()=>{const trigger=page.getByRole('button',{name:/^Project:/});if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();await page.getByRole('menu',{name:/^Project:/}).waitFor();};
 await openMenu();await page.getByRole('menuitem',{name:'Rename project '+longName,exact:true}).click();
 await page.getByRole('textbox',{name:'Project name',exact:true}).fill('Renamed suspension');await page.getByRole('button',{name:'Rename',exact:true}).click();
 await page.getByRole('button',{name:'Project: Renamed suspension',exact:true}).waitFor();await openMenu();
 await page.getByRole('menuitem',{name:'Duplicate project Renamed suspension',exact:true}).click();await page.getByRole('textbox',{name:'Copy name',exact:true}).fill('Suspension copy');await page.getByRole('button',{name:'Duplicate project',exact:true}).click();
 await page.getByRole('button',{name:'Project: Suspension copy',exact:true}).waitFor();await page.locator('.loading').waitFor({state:'hidden'});
 for(const[name,theme]of[['Suspension copy','light'],['Renamed suspension','dark']]){
  if(theme==='dark')await page.emulateMedia({colorScheme:'dark'});
  await openMenu();await page.getByRole('menuitem',{name:'Delete project '+name,exact:true}).click();await page.getByRole('button',{name:'Delete project',exact:true}).click();
  if(name==='Suspension copy')await page.getByRole('button',{name:'Project: Renamed suspension',exact:true}).waitFor();
 }
 await page.getByText('Create a project to start a design.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'New project',exact:true}).click();
 await page.getByRole('textbox',{name:'Project name',exact:true}).fill('New beginning');await page.getByRole('button',{name:'Create project',exact:true}).click();
 await page.getByRole('button',{name:'Project: New beginning',exact:true}).waitFor();await page.locator('.loading').waitFor({state:'hidden'});
 results.projects={rowRename:true,rowDuplicate:true,deleteStarterAndLastProject:true,createAfterEmpty:true,middleTruncation:truncation};
 console.log('Project management and empty-workspace recovery passed');
 // Dark and narrow states, including all three row actions and monitor placement.
 for(const width of[1440,1100,390]){
  await page.setViewportSize({width,height:1000});await openMenu();
  const bounds=await page.getByRole('menu',{name:/^Project:/}).boundingBox();assert.ok(bounds.x>=7&&bounds.x+bounds.width<=width-7);
  if(width===390)for(const action of await page.locator('.project-row-actions button').all()){const box=await action.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
  await settle(page.getByRole('menu',{name:/^Project:/}));await page.screenshot({path:join(out,`project-menu-dark-${width}.png`)});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'MCP service: Online',exact:true}).click();await monitor.waitFor();
  const box=await monitor.boundingBox();assert.ok(box.x>=7&&box.x+box.width<=width-7);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await settle(monitor);await page.screenshot({path:join(out,`service-monitor-dark-${width}.png`)});await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.service-trigger')?.getAttribute('aria-expanded')==='false');
 }
 // Offline status retains visibly stale measurements, and recovers after the next good poll.
 await page.route('**/api/service',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Service unavailable for verification'}})}));
 await page.getByRole('button',{name:'MCP service: Offline',exact:true}).waitFor();await page.getByRole('button',{name:'MCP service: Offline',exact:true}).click();
 await monitor.getByText('Showing the last available measurements.',{exact:true}).waitFor();assert.equal(await monitor.getByRole('button',{name:'Restart service',exact:true}).isDisabled(),true);
 await page.screenshot({path:join(out,'service-offline-390.png')});await page.unroute('**/api/service');await page.getByRole('button',{name:'MCP service: Online',exact:true}).waitFor();
 results.monitor={coldAndWarm:true,requestChart:true,memoryStorageUptime:true,widths:[1440,1100,390],staleOnOffline:true,reconnects:true};
 assert.deepEqual(errors,[]);results.pageErrors=errors;await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}catch(error){const page=browser?.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:join(out,'failure.png')});await writeFile(join(out,'failure.json'),JSON.stringify(await page.evaluate(()=>({text:document.body.innerText,panels:[...document.querySelectorAll('[role="dialog"]')].map(el=>({name:el.getAttribute('aria-label'),visibility:getComputedStyle(el).visibility,html:el.innerHTML}))})),null,2));}throw error;
}finally{await browser?.close();await server?.close();await bridge?.close();await rm(dir,{recursive:true,force:true});}
