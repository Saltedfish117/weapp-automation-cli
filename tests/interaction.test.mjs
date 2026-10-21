import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseElement, queryRoot, selectTextMatch, textMatches } from '../src/runtime/lib/interaction.mjs';
const el = text => ({ tagName:'view', size:async()=>({width:100,height:30}), offset:async()=>({left:0,top:0}), text:async()=>text, value:async()=>null, attribute:async()=>'' });

test('strict selectors reject ambiguity without firing a tap', async () => {
  const root = { $$:async()=>[el('下载账单'),el('筛选')] };
  await assert.rejects(chooseElement(root,'.action',{strict:true}), e=>e.code==='ambiguous-target' && e.data.count===2);
  const explicit = await chooseElement(root,'.action',{strict:true,index:1});
  assert.equal(await explicit.element.text(),'筛选');
});
test('non-strict selector warns, scoped container must be unique',async()=>{
  const chosen=await chooseElement({$$:async()=>[el('a'),el('b')]},'.x');
  assert.match(chosen.warning,/2 matches/);
  await assert.rejects(queryRoot({$$:async()=>[el('a'),el('b')]},'.parent'),e=>e.code==='ambiguous-container');
});
test('strict text rejects geometric overlap unless target is explicitly selected',()=>{
  const make=(left,top,width,height)=>({offset:{left,top},size:{width,height},area:width*height,text:'筛选'});
  const nested={matches:[make(0,0,300,60),make(20,10,40,20)],incomplete:false};
  assert.throws(()=>selectTextMatch(nested,{strict:true,query:'筛选'}),e=>e.code==='ambiguous-target');
  assert.equal(selectTextMatch(nested,{strict:true,query:'筛选',index:1}).match.area,800);
  assert.throws(()=>selectTextMatch({matches:[make(0,0,40,20),make(100,0,40,20)],incomplete:false},{strict:true,query:'筛选'}),e=>e.code==='ambiguous-target');
});
test('different overlapping SDK handles are never deduplicated',async()=>{
  const a=el('筛选'), b=el('筛选');
  const scan=await textMatches({$$:async()=>[a,b]},'筛选',{tag:'button',exact:true});
  assert.equal(scan.matches.length,2);
  assert.throws(()=>selectTextMatch(scan,{strict:true,query:'筛选'}),e=>e.code==='ambiguous-target');
});
test('strict text cannot pass an incomplete scan',()=>{
  assert.throws(()=>selectTextMatch({matches:[],incomplete:true,scanned:1500,maxScanned:1500},{strict:true}),e=>e.code==='incomplete-target-scan');
});
