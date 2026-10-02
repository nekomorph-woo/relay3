import {test,expect,_electron,chromium,type ElectronApplication,type Browser,type Page,type BrowserContext} from '@playwright/test';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
let app:ElectronApplication,browser:Browser,desktop:Page,mobile:Page,context:BrowserContext,dir:string,boot:any,base:string;
const errors:string[]=[];
async function admin(route:string,body?:unknown){return desktop.evaluate(async({route,body})=>{const boot=await window.relay3!.bootstrap();const response=await fetch(boot.controlUrl+'/admin'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${boot.adminToken}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;},{route,body});}
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{
 dir=mkdtempSync(path.join(os.tmpdir(),'relay3-ui-'));
 app=await _electron.launch({args:['.'],cwd:process.cwd(),env:{...process.env,RELAY3_DATA_DIR:dir}});
 desktop=await app.firstWindow();desktop.on('pageerror',e=>errors.push(e.message));await desktop.waitForLoadState('domcontentloaded');
 boot=await desktop.evaluate(()=>window.relay3!.bootstrap());
 await admin('/settings',{receiveDir:path.join(dir,'received')});
 browser=await chromium.launch({args:['--no-proxy-server']});context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',acceptDownloads:true});mobile=await context.newPage();mobile.on('pageerror',e=>errors.push(e.message));
});
test.afterAll(async()=>{await context?.close();await browser?.close();await app?.close();if(dir)rmSync(dir,{recursive:true,force:true});});
test('桌面开启中转站，手机客户端连接，双向传输并保留记录',async()=>{
 await desktop.getByRole('button',{name:'开启本机中转站'}).click();await expect(desktop.getByRole('heading',{name:'中转站已开启'})).toBeVisible();
 await desktop.getByRole('button',{name:'本机加入'}).click();await expect(desktop.locator('.connection-label')).toContainText('已连接');
 const status=await admin('/status');base=`http://127.0.0.1:${status.settings.port}`;
 await mobile.goto(`${base}/#pair=${status.pairingToken}`);await mobile.getByRole('button',{name:'连接设备',exact:true}).click();await mobile.getByLabel('设备名称').fill('测试手机');await mobile.locator('dialog').getByRole('button',{name:'连接',exact:true}).click();await expect(mobile.locator('.connection-label')).toContainText('已连接');
 await desktop.getByRole('button',{name:'文件传输',exact:true}).click();await expect(desktop.locator('.peer')).toContainText('测试手机');await desktop.locator('.peer').filter({hasText:'测试手机'}).click();
 const content=Buffer.from('relay3 桌面发给手机\n'.repeat(120000));await desktop.getByLabel('选择待发送文件').setInputFiles({name:'桌面文件.txt',mimeType:'text/plain',buffer:content});await desktop.getByRole('button',{name:'发送',exact:true}).click();
 const incoming=mobile.locator('.transfer-row').filter({hasText:'桌面文件.txt'});await incoming.getByRole('button',{name:'接收',exact:true}).click();await expect(incoming.getByRole('button',{name:'下载文件',exact:true})).toBeVisible();const downloadPromise=mobile.waitForEvent('download');await incoming.getByRole('button',{name:'下载文件',exact:true}).click();const download=await downloadPromise;await download.saveAs(path.join(dir,'mobile-download.txt'));expect(readFileSync(path.join(dir,'mobile-download.txt'))).toEqual(content);await incoming.getByRole('button',{name:'确认收到'}).click();await expect(incoming).toHaveCount(0);
 await mobile.locator('.composer select').selectOption(boot.deviceId);const back=Buffer.from('手机发送到电脑的文件');await mobile.getByLabel('选择待发送文件').setInputFiles({name:'手机文件.txt',mimeType:'text/plain',buffer:back});await mobile.getByRole('button',{name:'发送',exact:true}).click();const receive=desktop.locator('.transfer-row').filter({hasText:'手机文件.txt'});await receive.getByRole('button',{name:'接收',exact:true}).click();await expect(receive.getByRole('button',{name:'下载文件',exact:true})).toBeVisible();await receive.getByRole('button',{name:'下载文件',exact:true}).click();await expect(receive).toHaveCount(0);expect(readFileSync(path.join(dir,'received','手机文件.txt'))).toEqual(back);
 await desktop.getByRole('button',{name:'收发记录',exact:true}).click();await expect(desktop.locator('.record-row')).toHaveCount(2);await expect(desktop.locator('.record-row').first()).toContainText('已完成');
 await desktop.getByRole('button',{name:'文件存储',exact:true}).click();await expect(desktop.locator('.cache-row:not(.received-row)')).toHaveCount(2);await desktop.getByLabel('选择所有可清理文件').check();await desktop.getByRole('button',{name:/清理所选/}).click();await desktop.getByRole('button',{name:'确认清理'}).click();await expect(desktop.locator('.cache-row:not(.received-row)')).toHaveCount(0);
 await desktop.getByRole('button',{name:'收发记录',exact:true}).click();await expect(desktop.locator('.record-row')).toHaveCount(2);await expect(desktop.locator('.record-row').first()).toContainText('缓存已清理');expect(existsSync(path.join(dir,'received','手机文件.txt'))).toBeTruthy();
 await desktop.screenshot({path:'test-results/desktop-history.png',fullPage:true});
});
test('手机页面在 320、375、414、768 像素下无横向溢出，设置可保存',async()=>{
 for(const width of [320,375,414,768]){await mobile.setViewportSize({width,height:900});for(const name of ['文件传输','收发记录','设置']){await mobile.getByRole('button',{name,exact:true}).click();const dimensions=await mobile.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);}}
 await mobile.getByLabel('设备名称').fill('手机新名称');await mobile.getByRole('button',{name:'保存设置'}).click();await expect(mobile.getByRole('status')).toContainText('设置已保存');await mobile.setViewportSize({width:375,height:812});await mobile.getByRole('button',{name:'文件传输',exact:true}).click();await mobile.screenshot({path:'test-results/mobile-transfer.png',fullPage:true});expect(errors).toEqual([]);
});
test('断开历史保存，中转站与客户端可独立关闭，目录路径可见',async()=>{
 await mobile.getByRole('button',{name:'断开',exact:true}).click();await desktop.getByRole('button',{name:'连接设备',exact:true}).click();await expect(desktop.locator('.device-record').filter({hasText:'手机新名称'})).toContainText('已断开');await expect(desktop.locator('.timeline')).toContainText('断开');
 await desktop.getByRole('button',{name:'中转站',exact:true}).click();await desktop.getByRole('button',{name:'关闭中转站',exact:true}).click();await desktop.locator('dialog').getByRole('button',{name:'关闭中转站',exact:true}).click();await expect(desktop.locator('dialog')).toHaveCount(0);await expect(desktop.getByRole('heading',{name:'开启这台电脑的中转站'})).toBeVisible();
 await desktop.getByRole('button',{name:'设置',exact:true}).click();await desktop.getByRole('spinbutton',{name:'完成后保留时间（小时）'}).fill('2');await desktop.getByRole('button',{name:'保存设置',exact:true}).click();await expect(desktop.getByRole('status')).toContainText('设置已保存');
 await desktop.getByRole('button',{name:'文件存储',exact:true}).click();await expect(desktop.locator('.paths')).toContainText(path.join(dir,'relay3.sqlite'));expect(errors).toEqual([]);
});
