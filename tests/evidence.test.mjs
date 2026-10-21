import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidence } from '../src/runtime/lib/evidence.mjs';

test('evidence defaults unknown and uncovered, not certified real',()=>{
  const e=createEvidence(); assert.equal(e.report.dataSource,'unknown');
  assert.ok(e.report.uncovered.includes('physical-gesture'));
  e.record('programmatic-scroll',{selector:'.list'});
  assert.equal(e.report.interactions[0].interaction,'programmatic-scroll');
});
test('declared provenance is labelled and cannot silently remove uncovered items',()=>{
  const e=createEvidence(); e.declare({dataSource:'real-service',uncovered:[],notes:['read-only']});
  assert.equal(e.report.declarations[0].source,'script-declared');
  assert.ok(e.report.uncovered.includes('android-device'));
  assert.throws(()=>e.declare({dataSource:'real'}),/invalid/);
  assert.throws(()=>e.declare({uncovered:'none'}),/array/);
});
