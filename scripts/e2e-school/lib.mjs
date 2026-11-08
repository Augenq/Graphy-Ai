import { chromium } from 'playwright-core'; import fs from 'node:fs';
export const tok = JSON.parse(fs.readFileSync('tokens.json'));
export async function open(who, vp={width:1280,height:860}) {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: vp });
  await ctx.addInitScript(t => { try { localStorage.setItem('graphy-hub-token', t); } catch {} }, tok[who]);
  const p = await ctx.newPage(); p.errs=[];
  p.on('console', m => m.type()==='error' && p.errs.push(m.text().slice(0,160)));
  p.on('pageerror', e => p.errs.push('PAGEERR '+e.message.slice(0,160)));
  p.on('response', r => r.status()>=400 && p.errs.push(r.status()+' '+r.url().slice(0,100)));
  return { b, p };
}
