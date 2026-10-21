import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDiagnostics } from '../src/runtime/lib/diagnostics.mjs';

test('step timeout reports its name, route and state even if screenshots fail',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'weapp-diagnostics-'));
  try {
    const page={path:'pages/income',query:{},data:async()=>({rows:Array.from({length:410},(_,i)=>i)})};
    const session={mp:{currentPage:async()=>page,screenshot:async()=>{throw new Error('not painted');}}};
    const d=createDiagnostics(session,{directory:temp,operationTimeoutMs:50,screenshotTimeoutMs:50});
    let err;
    try { await d.step('原生布局检查',()=>new Promise(()=>{}),{timeoutMs:20}); } catch(e) { err=e; }
    assert.equal(err.code,'step-timeout'); assert.equal(err.data.step.name,'原生布局检查');
    assert.equal(err.data.diagnostics.route.path,'pages/income');
    assert.equal(err.data.diagnostics.captured,true);
    assert.ok(err.data.diagnostics.warnings.some(s=>s.startsWith('screenshot:')));
    const state=JSON.parse(await fs.readFile(err.data.diagnostics.statePath,'utf8'));
    assert.equal(state.data.rows.length,410); assert.equal(state.activeStep.name,'原生布局检查');
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});
test('disabled diagnostics perform no page reads',async()=>{
  const d=createDiagnostics({mp:{currentPage:async()=>{throw new Error('should not read');}}},{enabled:false});
  assert.deepEqual(await d.capture(new Error('x')),{captured:false,disabled:true});
});
