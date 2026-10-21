import test from 'node:test';
import assert from 'node:assert/strict';
import { readyFor } from '../src/runtime/lib/ready-adapter.mjs';
const dataSpec=value=>({conditions:[{type:'data',keyPath:'value',equals:value}],timeoutMs:40,intervalMs:5,stableSamples:2,stableWindowMs:0});

test('readiness does not normalize NaN or undefined fields to matching JSON',async()=>{
  for(const [actual,expected] of [[NaN,null],[{x:undefined},{}]]){
    const mp={currentPage:async()=>({path:'target',data:async()=>({value:actual})})};
    const r=await readyFor(mp,dataSpec(expected));
    assert.notEqual(r.status,'passed');
  }
});
test('unrelated non-JSON data does not poison requested finite path',async()=>{
  const mp={currentPage:async()=>({path:'target',data:async()=>({value:1,unrelated:undefined})})};
  assert.equal((await readyFor(mp,dataSpec(1))).status,'passed');
});
test('route transition during reading invalidates the entire sample',async()=>{
  let reads=0;
  const page={path:'target',data:async()=>({value:1})};
  const mp={currentPage:async()=> (++reads%2 ? page : {path:'other'})};
  const r=await readyFor(mp,{...dataSpec(1),conditions:[{type:'route',equals:'target'},{type:'data',keyPath:'value',equals:1}]});
  assert.notEqual(r.status,'passed');
});
