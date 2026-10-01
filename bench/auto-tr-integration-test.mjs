import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createAutoTrController,chooseTurkishTrack} from '../src/auto-tr-controller.js';

const en = {languageCode:'en',kind:'asr',baseUrl:'https://www.youtube.com/api/timedtext?lang=en&signature=fixture',isTranslatable:true};
const tr = {languageCode:'tr',baseUrl:'https://www.youtube.com/api/timedtext?lang=tr'};
function harness(tracks=[en]) {
  let time=0, seq=0; const timers=new Map(), calls=[], records=[], listenerAdds=[], listenerRemoves=[];
  let id='videoA', responseId=id, ready=true, current={}, player, userIntent=false, autoSelectionEnabled=true;
  const userChanges=[];
  let model={captionTracks:tracks};
  let response={videoDetails:{videoId:responseId},captions:{playerCaptionsTracklistRenderer:model}};
  const p={getVideoData:()=>({video_id:id}),getPlayerResponse:()=>response,
    getOption:()=>current, getOptions:()=>ready?['track']:[],loadModule:()=>calls.push('load'),
    setOption:(module,option,value)=>{calls.push(value); if(ready) current=value;},
    addEventListener:(event,fn)=>listenerAdds.push({event,fn}),
    removeEventListener:(event,fn)=>listenerRemoves.push({event,fn})};
  player=p;
  const deps={getPlayer:()=>player,now:()=>time,record:(code,detail)=>records.push({code,...detail}),
    schedule:(fn,delay)=>{timers.set(++seq,{fn,at:time+delay});return seq;},cancel:id=>timers.delete(id),
    isUserInitiatedChange:()=>userIntent,isAutoSelectionEnabled:()=>autoSelectionEnabled,
    onUserCaptionChange:track=>{userChanges.push(track);autoSelectionEnabled=Object.keys(track||{}).length>0;}};
  const auto=createAutoTrController(deps);
  const advance=ms=>{const end=time+ms;let limit=1000;while(limit--){const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>end)break;timers.delete(entry[0]);time=entry[1].at;entry[1].fn();}time=end;};
  return {p,auto,deps,calls,records,timers,listenerAdds,listenerRemoves,advance,get current(){return current;},
    setCurrent:value=>{current=value;},setReady:value=>{ready=value;},
    change:(next,newTracks,nextResponse=next)=>{id=next;responseId=nextResponse;tracks=newTracks;
      model={captionTracks:tracks};response={videoDetails:{videoId:responseId},captions:{playerCaptionsTracklistRenderer:model}};current={};},
    replaceCaptionModel:()=>{model={captionTracks:tracks};
      response={videoDetails:{videoId:responseId},captions:{playerCaptionsTracklistRenderer:model}};},
    setUserIntent:value=>{userIntent=value;},setAutoSelectionEnabled:value=>{autoSelectionEnabled=value;},userChanges,
    replacePlayer:()=>{player={...p};current={};}};
}

test('AUTO_TR waits for caption initialization and selects via API',()=>{
  const h=harness();h.setReady(false);h.auto.start();h.advance(2000);
  assert.deepEqual(h.calls,['load']);h.setReady(true);h.advance(4000);
  assert.equal(h.current.translationLanguage.languageCode,'tr');assert.equal(h.auto.status().selected,true);
});
test('native TR has priority; English then other available source; no captions is a no-op',()=>{
  assert.equal(chooseTurkishTrack({captionTracks:[en,tr]}).native,true);
  assert.equal(chooseTurkishTrack({captionTracks:[{...en,languageCode:'es'},en]}).track.languageCode,'en');
  assert.equal(chooseTurkishTrack({captionTracks:[{...en,languageCode:'es'}]}).track.translationLanguage.languageCode,'tr');
  for(const tracks of [[],[ {...en,isTranslatable:false} ]]) {
    const h=harness(tracks);h.auto.start();h.advance(60000);assert.deepEqual(h.calls,[]);
  }
  const h=harness([en,tr]);h.auto.start();h.advance(3000);
  assert.equal(h.current.languageCode,'tr');assert.equal(h.current.translationLanguage,undefined);
});
test('playlist next, stale response, player replacement and late caption model',()=>{
  const h=harness();h.auto.start();h.advance(3000);
  h.change('videoB',[tr],'videoA');h.advance(3000);assert.deepEqual(h.current,{});
  h.change('videoB',[tr]);h.advance(3000);assert.equal(h.current.languageCode,'tr');
  h.change('videoC',[]);h.advance(30000);const count=h.calls.length;
  h.change('videoC',[en]);h.advance(3000);assert.ok(h.calls.length>count);assert.equal(h.current.translationLanguage.languageCode,'tr');
  h.replacePlayer();h.advance(3000);assert.equal(h.current.translationLanguage.languageCode,'tr');
  assert.equal(h.listenerRemoves.length,3);assert.equal(h.listenerAdds.length,6);
});
test('seek is idempotent and a post-selection user change is never overwritten',()=>{
  const h=harness();h.auto.start();h.advance(3000);const count=h.calls.length;
  h.auto.notify();h.advance(3000);assert.equal(h.calls.length,count);
  h.setCurrent({});h.auto.userAction(h.p,'videoA');h.auto.notify();h.advance(30000);
  assert.deepEqual(h.current,{});assert.equal(h.calls.length,count);
  assert.equal(h.auto.status().reason,'USER_OVERRIDE');
});

test('same-model internal menu change is accepted as user intent',()=>{
  const h=harness();h.auto.start();h.advance(3000);const count=h.calls.length;
  h.setUserIntent(true);
  h.setCurrent({languageCode:'en',kind:'asr'});h.auto.notify();h.advance(3000);
  assert.deepEqual(h.current,{languageCode:'en',kind:'asr'});
  assert.equal(h.calls.length,count);assert.equal(h.auto.status().reason,'USER_OVERRIDE');
  assert.ok(h.records.some(record=>record.code==='USER_CAPTION_STATE_ACCEPTED' &&
    record.source==='user' && record.playerGeneration===1));
});

test('user OFF persists across video generations until an explicit ON action',()=>{
  const h=harness();h.auto.start();h.advance(3000);
  h.setCurrent({});h.auto.userAction(h.p,'videoA',{});h.auto.notify();h.advance(1100);
  assert.equal(h.auto.status().reason,'USER_DISABLED');
  const count=h.calls.length;h.change('videoB',[en]);h.advance(5000);
  assert.deepEqual(h.current,{});assert.equal(h.calls.length,count);
  h.auto.userAction(h.p,'videoB',{languageCode:'en',kind:'asr'});
  h.setCurrent({languageCode:'en',kind:'asr'});h.advance(1100);
  assert.equal(h.auto.status().reason,'USER_OVERRIDE');
  h.change('videoC',[en]);h.advance(3000);
  assert.equal(h.current.translationLanguage.languageCode,'tr');
});

test('same-model late lifecycle reset is recovered without a user override',()=>{
  const h=harness();h.auto.start();h.advance(3000);const count=h.calls.length;
  h.setCurrent({languageCode:'en',kind:'asr'});h.auto.notify();h.advance(3000);
  assert.equal(h.current.translationLanguage.languageCode,'tr');
  assert.ok(h.calls.length>count);assert.equal(h.auto.status().userOverride,false);
  assert.ok(h.records.some(record=>record.code==='CAPTION_STATE_DRIFT' &&
    record.source==='youtube-lifecycle'));
});

test('same-video replacement caption model reapplies confirmed TR once',()=>{
  const h=harness();h.auto.start();h.advance(3000);const count=h.calls.length;
  h.replaceCaptionModel();h.setCurrent({languageCode:'en',kind:'asr'});h.auto.notify();h.advance(3000);
  assert.equal(h.current.translationLanguage.languageCode,'tr');
  assert.equal(h.calls.length,count+1);
  assert.equal(h.records.filter(record=>record.code==='CAPTION_MODEL_INSTANCE_CHANGED').length,1);
  assert.equal(h.records.filter(record=>record.code==='AUTO_MODEL_REAPPLY').length,1);
});

test('cold OFF, brief init, user TR and late rehydration keeps TR after 10s, seek and pause',()=>{
  const h=harness();h.setReady(false);h.auto.start();
  h.setCurrent({languageCode:'en',kind:'asr'});h.advance(100);
  h.setCurrent({});h.setReady(true);
  const target={languageCode:'en',kind:'asr',translationLanguage:{languageCode:'tr',languageName:'Türkçe'}};
  h.setCurrent(target);h.auto.notify();h.advance(1100);
  assert.equal(h.auto.status().selected,true);
  h.replaceCaptionModel();h.setCurrent({languageCode:'en',kind:'asr'});h.auto.notify();h.advance(10000);
  assert.equal(h.current.translationLanguage.languageCode,'tr');
  const count=h.calls.length;
  h.auto.notify();h.advance(10000); // seek and pause/resume lifecycle wakes
  assert.equal(h.current.translationLanguage.languageCode,'tr');
  assert.equal(h.calls.length,count);
  assert.equal(h.records.filter(record=>record.code==='AUTO_MODEL_REAPPLY').length,1);
});

test('OFF/ON and EN/TR user mutations each stick on the first action, 20 times',()=>{
  const h=harness();h.auto.start();h.advance(3000);const automaticCalls=h.calls.length;
  const states=[{}, {languageCode:'en',kind:'asr'},
    {languageCode:'en',kind:'asr',translationLanguage:{languageCode:'tr'}}];
  for(let round=0;round<20;round++) {
    for(const requested of states) {
      h.setCurrent(requested);h.auto.userAction(h.p,'videoA');h.auto.notify();h.advance(1100);
      assert.deepEqual(h.current,requested);
      assert.equal(h.calls.length,automaticCalls);
    }
  }
});
test('initialization timeout is bounded; HTTP failure does not fight source fallback',()=>{
  const h=harness();h.setReady(false);h.auto.start();h.advance(60000);
  assert.equal(h.auto.status().attempts,8);assert.deepEqual(h.calls,['load']);
  const f=harness();f.auto.start();f.advance(3000);f.auto.failed(f.p,'videoA');f.setCurrent({languageCode:'en',kind:'asr'});
  assert.equal(f.auto.status().selected,false);assert.equal(f.auto.status().reason,'REQUEST_FAILED');
  const count=f.calls.length;f.advance(30000);assert.equal(f.calls.length,count);assert.equal(f.auto.status().reason,'REQUEST_FAILED');
});
test('OFF cancels pending work, even before captions become ready',()=>{
  const h=harness();h.auto.start();h.auto.stop();h.advance(30000);
  assert.deepEqual(h.calls,['load']);assert.equal(h.timers.size,0);assert.equal(h.auto.status().enabled,false);
});
test('AUTO_TR user preference survives a fresh app instance and a different video',()=>{
  const storage=new Map();
  const source=readFileSync(new URL('../src/turkish-captions-poc.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/m,'').replaceAll('export function ','function ');
  function boot(h){
    const context=vm.createContext({window:{},document:{getElementById:()=>h.p},
      localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
      createAutoTrController:args=>createAutoTrController({...h.deps,...args}),chooseTurkishTrack,
      XMLHttpRequest:class{open(){}},URL,setTimeout,clearTimeout,AbortController});
    vm.runInContext(source,context);return context.window.__YTTR_POC__;
  }
  const a=harness(), app=boot(a);assert.equal(app.status().mode,'OFF');
  app.setMode('AUTO_TR');a.advance(3000);assert.equal(a.current.translationLanguage.languageCode,'tr');
  const stored=JSON.parse(storage.get('yttr.caption.preference'));
  assert.deepEqual(stored,{version:2,mode:'AUTO_TR',targetLanguage:'tr',captionsEnabled:true});
  const b=harness([en,tr]);b.change('anotherVideo',[en,tr]);const fresh=boot(b);b.advance(3000);
  assert.equal(fresh.status().mode,'AUTO_TR');assert.equal(b.current.languageCode,'tr');assert.equal(b.current.translationLanguage,undefined);
});

test('user caption OFF preference survives app restart and a different video',()=>{
  const storage=new Map([['yttr.caption.preference',
    JSON.stringify({version:2,mode:'AUTO_TR',targetLanguage:'tr',captionsEnabled:true})]]);
  const source=readFileSync(new URL('../src/turkish-captions-poc.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/m,'').replaceAll('export function ','function ');
  function boot(h){
    const context=vm.createContext({window:{},document:{getElementById:()=>h.p},
      localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
      createAutoTrController:args=>createAutoTrController({...h.deps,...args}),chooseTurkishTrack,
      XMLHttpRequest:class{open(){}},URL,setTimeout,clearTimeout,AbortController,WeakSet,Date});
    vm.runInContext(source,context);return context.window.__YTTR_POC__;
  }
  const first=harness();const app=boot(first);first.advance(3000);
  first.p.setOption('captions','track',{});first.advance(1100);
  assert.equal(app.status().captionsEnabledPreference,false);
  assert.equal(JSON.parse(storage.get('yttr.caption.preference')).captionsEnabled,false);
  const second=harness();second.change('videoAfterRestart',[en]);const restarted=boot(second);second.advance(5000);
  assert.equal(restarted.status().mode,'AUTO_TR');
  assert.equal(restarted.status().captionsEnabledPreference,false);
  assert.deepEqual(second.current,{});
  assert.deepEqual(second.calls,[]);
});

test('caption setter instrumentation labels auto/user mutations without URL or auth data',async()=>{
  const h=harness(), storage=new Map([['yttr.caption.preference',
    JSON.stringify({version:1,mode:'AUTO_TR',targetLanguage:'tr'})]]);
  const source=readFileSync(new URL('../src/turkish-captions-poc.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/m,'').replaceAll('export function ','function ');
  const context=vm.createContext({window:{},document:{getElementById:()=>h.p},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    createAutoTrController:args=>createAutoTrController({...h.deps,...args}),chooseTurkishTrack,
    XMLHttpRequest:class{open(){}},URL,setTimeout,clearTimeout,AbortController,WeakSet,Date});
  vm.runInContext(source,context);h.advance(3000);
  for(let i=0;i<20;i++) {
    h.p.setOption('captions','track',{});h.advance(1100);assert.deepEqual(h.current,{});
    h.p.setOption('captions','track',{languageCode:'en',kind:'asr'});h.advance(1100);
    assert.equal(h.current.languageCode,'en');
  }
  await new Promise(resolve=>setTimeout(resolve,150));
  const status=context.window.__YTTR_POC__.status();
  const mutations=status.events.filter(event=>event.code==='CAPTION_MUTATION');
  assert.ok(mutations.some(event=>event.source==='auto'));
  assert.equal(mutations.filter(event=>event.source==='user').length,40);
  for(const event of mutations) {
    assert.ok(event.timestamp);assert.ok(event.videoId);assert.ok(event.playerGeneration);
    assert.ok(event.requestedState);assert.ok(event.previousState);assert.ok(event.resultingState);
    assert.ok(event.listenerIdentity);
  }
  const serialized=JSON.stringify(mutations);
  assert.equal(/signature=|cookie|authorization|baseUrl/i.test(serialized),false);
  assert.equal(status.auto.reason,'USER_OVERRIDE');
});

test('XHR observer preserves requests, ignores abort/stale results, and bounds HTTP fallback',()=>{
  const h=harness();
  class XHR {
    constructor(){this.listeners={};this.responseType='text';this.responseText='';this.status=503;}
    addEventListener(k,fn){(this.listeners[k] ||= []).push(fn);}
    emit(k){for(const fn of this.listeners[k]||[])fn();}
    open(...args){this.args=args;return 'original-open';}
  }
  const source=readFileSync(new URL('../src/turkish-captions-poc.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/m,'').replaceAll('export function ','function ');
  const context=vm.createContext({window:{},document:{getElementById:()=>h.p},location:{href:'https://www.youtube.com/tv'},
    localStorage:{getItem:()=>null,setItem(){}},createAutoTrController:args=>createAutoTrController({...h.deps,...args}),
    chooseTurkishTrack,XMLHttpRequest:XHR,URL,setTimeout,clearTimeout,AbortController});
  vm.runInContext(source,context);const app=context.window.__YTTR_POC__;app.setMode('AUTO_TR');h.advance(3000);
  const url=en.baseUrl+'&kind=asr&tlang=tr';
  const aborted=new XHR();assert.equal(aborted.open('GET',url,true),'original-open');
  assert.deepEqual(aborted.args,['GET',url,true]);aborted.emit('abort');aborted.emit('loadend');
  assert.equal(h.current.translationLanguage.languageCode,'tr');
  const stale=new XHR();stale.open('GET',url,true);h.change('videoB',[en]);h.advance(3000);
  stale.emit('loadend');assert.equal(h.current.translationLanguage.languageCode,'tr');
  const failed=new XHR();failed.open('GET',url,true);failed.emit('loadend');
  assert.equal(h.current.languageCode,'en');assert.equal(h.current.translationLanguage,undefined);
  const count=h.calls.length;h.advance(30000);assert.equal(h.calls.length,count);
  assert.equal(app.status().auto.reason,'REQUEST_FAILED');
  assert.equal(JSON.stringify(app.status()).includes('signature'),false);
});

