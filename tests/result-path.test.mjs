import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateResultPath } from '../src/runtime/lib/result-path.mjs';

test('result output rejects sources and parent junctions into skill',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'weapp-result-path-'));
  try{
    const skill=path.join(root,'skill');fs.mkdirSync(skill);
    assert.throws(()=>validateResultPath(path.join(skill,'x.json'),skill),e=>e.code==='bad-output-path');
    assert.throws(()=>validateResultPath(path.join(root,'x.mjs'),skill),e=>e.code==='bad-output-path');
    const link=path.join(root,'alias');fs.symlinkSync(skill,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>validateResultPath(path.join(link,'nested','x.json'),skill),e=>e.code==='bad-output-path');
    assert.equal(validateResultPath(path.join(root,'out.json'),skill),path.join(root,'out.json'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
