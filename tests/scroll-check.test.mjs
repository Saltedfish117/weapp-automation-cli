import test from 'node:test';
import assert from 'node:assert/strict';
import { assessScrollTrace, attemptSwipe } from '../src/runtime/lib/scroll-check.mjs';

test('synthetic no-op touch is uncovered, not a passed gesture',()=>{
  const r=assessScrollTrace([0,100,200].map(elapsedMs=>({elapsedMs,top:0})),{releaseAtMs:100,interaction:'sdk-touch-events'});
  assert.equal(r.status,'unsupported'); assert.equal(r.moved,false); assert.equal(r.physicalGestureVerified,false);
  assert.ok(r.uncovered.includes('physical-gesture'));
});
test('actual movement and postrelease trace are measured separately',()=>{
  const r=assessScrollTrace([{elapsedMs:0,top:0},{elapsedMs:100,top:100},{elapsedMs:150,top:130},{elapsedMs:200,top:140}],{releaseAtMs:100,interaction:'sdk-touch-events',requireInertia:true});
  assert.equal(r.moved,true); assert.equal(r.inertiaObserved,true); assert.equal(r.inertiaRange,40);
  assert.equal(r.physicalGestureVerified,false); assert.ok(r.uncovered.includes('physical-gesture'));
});
test('missing offsets never certify stability or movement',()=>{
  const r=assessScrollTrace([{elapsedMs:0,top:null},{elapsedMs:50,top:10}]);
  assert.equal(r.status,'unsupported'); assert.ok(r.uncovered.includes('native-scroll-measurement'));
});
test('swipe rejects malformed coordinates before SDK side effects',async()=>{
  let sent=false;
  await assert.rejects(attemptSwipe({}, {touchstart:async()=>{sent=true;}},{selector:'.list',from:{x:NaN,y:1}}),e=>e.code==='bad-spec');
  assert.equal(sent,false);
});
