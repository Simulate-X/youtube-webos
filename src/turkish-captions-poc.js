// Development-only PoC. The normal upstream build aliases this module away.
// Proven on webOS 25: setOption(captions, track, {translationLanguage:{languageCode:'tr'}}).
import {createAutoTrController, chooseTurkishTrack} from './auto-tr-controller.js';
const MODE_KEY = 'yttr.poc.mode'; // One-time compatibility read for the manual PoC.
const PREFERENCE_KEY = 'yttr.caption.preference';
const TRACE_KEY = 'yttr.caption.trace.next';
const PLAYER_ID = 'ytlr-player__player-container-player';

export function withTurkishTarget(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.pathname !== '/api/timedtext' || url.username || url.password || url.port) {
    throw new Error('UNEXPECTED_CAPTION_ENDPOINT');
  }
  // Parse for validation only. URLSearchParams serialization can change signed
  // query encoding; retain every original byte except the target-language field.
  const hashAt = baseUrl.indexOf('#');
  const head = hashAt < 0 ? baseUrl : baseUrl.slice(0, hashAt);
  const tail = hashAt < 0 ? '' : baseUrl.slice(hashAt);
  const question = head.indexOf('?');
  const prefix = question < 0 ? head : head.slice(0, question);
  const parts = question < 0 ? [] : head.slice(question + 1).split('&');
  let replaced = false;
  const query = parts.map(part => {
    if (decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')) !== 'tlang') return part;
    if (replaced) throw new Error('AMBIGUOUS_TARGET_LANGUAGE');
    replaced = true;
    return 'tlang=tr';
  });
  if (!replaced) query.push('tlang=tr');
  return `${prefix}?${query.join('&')}${tail}`;
}

export function captionModel(response) {
  return response?.captions?.playerCaptionsTracklistRenderer;
}

export function englishSource(model) {
  if (!Array.isArray(model?.captionTracks)) return null;
  if (model.captionTracks.some(t => t?.languageCode === 'tr')) return null;
  return model.captionTracks.find(t => /^en(?:-|$)/.test(t?.languageCode || '') &&
    t.isTranslatable === true && typeof t.baseUrl === 'string') || null;
}

export function addTurkishTranslation(response) {
  const model = captionModel(response);
  const target = chooseTurkishTrack(model);
  if (!target || target.native || !Array.isArray(model.translationLanguages) ||
      model.translationLanguages.some(t => t?.languageCode === 'tr')) return false;
  // Preserve captionTracks, audioTracks, indices and every signed URL unchanged.
  model.translationLanguages = [...model.translationLanguages,
    {languageCode: 'tr', languageName: {simpleText: 'Türkçe'}}];
  return true;
}

export function cueCount(text) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  if (text.trim().startsWith('{')) {
    try {
      return JSON.parse(text).events?.filter(e => e.segs?.some(s => s.utf8?.trim())).length || 0;
    } catch { return 0; }
  }
  // Evidence/validation only, never HTML injection. DOMParser is blocked by
  // YouTube's TrustedHTML policy even for XML on the tested TV.
  return [...text.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
    .filter(m => m[1].replace(/<[^>]*>/g, '').trim()).length;
}

function install() {
  if (window.__YTTR_POC__) return;
  let mode = 'OFF', captionsEnabledPreference = true;
  try {
    const preference = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || 'null');
    if (preference?.targetLanguage === 'tr' && ['OFF', 'MANUAL', 'AUTO_TR'].includes(preference.mode)) {
      mode = preference.mode;
      captionsEnabledPreference = preference.captionsEnabled !== false;
    }
    else if (localStorage.getItem(MODE_KEY) === 'MANUAL') mode = 'MANUAL';
  } catch { /* OFF */ }
  const events = [];
  let auto;
  function record(code, detail = {}) {
    const policy = auto?.status?.();
    events.push({timestamp:new Date().toISOString(), code,
      autoTrPolicy:{mode, targetLanguage:'tr', enabled:policy?.enabled || false,
        reason:policy?.reason || 'NOT_READY'},
      manualUserOverride:policy?.userOverride || false,
      retryAttempt:policy?.attempts || 0, ...detail});
    if (events.length > 5000) events.shift();
  }
  const videoId = p => p?.getVideoData?.()?.video_id;
  const savePreference = () => localStorage.setItem(PREFERENCE_KEY,
    JSON.stringify({version:2, mode, targetLanguage:'tr', captionsEnabled:captionsEnabledPreference}));
  const identities = new WeakMap();
  let identitySequence = 0, lastWrappedMutation = null, lastRehydration = null;
  let lastUserInput = null;
  const identity = (value, prefix) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return `${prefix}-none`;
    if (!identities.has(value)) identities.set(value, `${prefix}-${++identitySequence}`);
    return identities.get(value);
  };
  const contextDetails = (p, response = p?.getPlayerResponse?.(), model = captionModel(response)) => ({
    playerIdentity:identity(p, 'player'), playerResponseIdentity:identity(response, 'response'),
    captionModelIdentity:identity(model, 'caption-model')
  });
  let autoMutation = null;
  const instrumentedPlayers = new WeakSet();
  const safeTrack = track => track && typeof track === 'object' ? {
    languageCode:track.languageCode || '', kind:track.kind || '',
    translationLanguage:track.translationLanguage?.languageCode || '',
    enabled:Object.keys(track).length > 0
  } : {languageCode:'', kind:'', translationLanguage:'', enabled:false};
  function instrumentPlayer(p) {
    if (!p || instrumentedPlayers.has(p) || typeof p.setOption !== 'function') return p;
    const originalSetOption = p.setOption;
    try {
      p.setOption = function (module, option, requested) {
        if (module !== 'captions' || option !== 'track') return originalSetOption.apply(this, arguments);
        const context = autoMutation;
        const source = context ? 'auto' : 'user';
        const generation = context?.playerGeneration || auto?.status?.().playerGeneration || 0;
        const identity = context?.listenerIdentity || `youtube-caption-setter-g${generation}`;
        let previous;
        try { previous = safeTrack(p.getOption?.('captions', 'track')); } catch { previous = safeTrack(null); }
        const result = originalSetOption.apply(this, arguments);
        lastWrappedMutation = {at:Date.now(), source, requested:safeTrack(requested)};
        if (source === 'user') auto?.userAction?.(p, videoId(p), requested);
        setTimeout(() => {
          let resulting;
          try { resulting = safeTrack(p.getOption?.('captions', 'track')); } catch { resulting = safeTrack(null); }
          record('CAPTION_MUTATION', {videoId:videoId(p), playerGeneration:generation, source,
            requestedState:safeTrack(requested), previousState:previous, resultingState:resulting,
            captionsEnabled:resulting.enabled, wrappedSetOption:true,
            fromPlayerResponseRehydration:false, newCaptionModelInstance:false,
            listenerIdentity:identity, ...contextDetails(p)});
        }, 100);
        return result;
      };
      for (const eventName of ['onApiChange', 'onStateChange', 'onVideoDataChange']) {
        p.addEventListener?.(eventName, eventValue => {
          let current;
          try { current = safeTrack(p.getOption?.('captions', 'track')); }
          catch { current = safeTrack(null); }
          record('PLAYER_EVENT', {videoId:videoId(p), eventSource:eventName,
            eventValue:typeof eventValue === 'string' || typeof eventValue === 'number' ? eventValue : null,
            activePlayer:document.getElementById(PLAYER_ID) === p,
            resultingState:current, captionsEnabled:current.enabled,
            wrappedSetOption:false, listenerIdentity:`yttr-player-event-${eventName}`,
            ...contextDetails(p)});
        });
      }
      instrumentedPlayers.add(p);
    } catch { record('CAPTION_INSTRUMENTATION_UNAVAILABLE', {videoId:videoId(p)}); }
    return p;
  }
  const player = () => instrumentPlayer(document.getElementById(PLAYER_ID));
  const rememberUserInput = event => {
    if (event?.isTrusted === false) return;
    const keyCode = event?.keyCode || event?.which || 0;
    if (event.type === 'keydown' && keyCode !== 13) return;
    lastUserInput = {at:Date.now(), type:event.type, keyCode};
    record('USER_INPUT', {eventSource:event.type, keyCode,
      listenerIdentity:'yttr-user-intent-observer'});
  };
  document.addEventListener?.('keydown', rememberUserInput, true);
  document.addEventListener?.('click', rememberUserInput, true);
  const isUserInitiatedChange = () => !!lastUserInput && Date.now() - lastUserInput.at <= 750;
  function applyAutoTrack(p, track, context) {
    autoMutation = context;
    try { p.setOption('captions', 'track', track); }
    finally { autoMutation = null; }
  }
  function rememberCaptionPreference(track) {
    const enabled = !!track && typeof track === 'object' && Object.keys(track).length > 0;
    if (captionsEnabledPreference === enabled) return;
    captionsEnabledPreference = enabled;
    savePreference();
    record('CAPTION_VISIBILITY_PREFERENCE_CHANGED', {captionsEnabled:enabled, source:'user'});
  }
  auto = createAutoTrController({getPlayer:player, record, applyTrack:applyAutoTrack,
    describeContext:contextDetails, isUserInitiatedChange,
    isAutoSelectionEnabled:() => captionsEnabledPreference,
    onUserCaptionChange:rememberCaptionPreference});
  const originalParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = originalParse.call(this, text, reviver);
    if (mode === 'OFF' || !result || typeof result !== 'object') return result;
    try {
      for (const response of [result, result.playerResponse]) {
        const model = captionModel(response);
        if (!model) continue;
        const details = contextDetails(player(), response, model);
        const added = addTurkishTranslation(response);
        lastRehydration = {at:Date.now(), ...details};
        record('PLAYER_RESPONSE_REHYDRATED', {videoId:response?.videoDetails?.videoId,
          source:'youtube-rehydration', injectedTurkish:added,
          wrappedSetOption:false, fromPlayerResponseRehydration:true,
          newCaptionModelInstance:true, ...details});
      }
    } catch { record('METADATA_PASSTHROUGH'); }
    return result;
  };

  let traceTimer = null, traceUntil = 0, lastTraceState = '';
  function stopTrace(reason = 'TRACE_STOPPED') {
    if (traceTimer !== null) clearTimeout(traceTimer);
    traceTimer = null; traceUntil = 0;
    record(reason);
  }
  function traceSample() {
    if (!traceUntil || Date.now() >= traceUntil) {stopTrace('TRACE_COMPLETE'); return;}
    const p = player(), current = safeTrack(p?.getOption?.('captions', 'track'));
    const model = captionModel(p?.getPlayerResponse?.());
    const rendered = [...document.querySelectorAll('.ytp-caption-segment')]
      .some(node => !!node.textContent?.trim());
    const snapshot = {videoId:videoId(p), ...contextDetails(p, p?.getPlayerResponse?.(), model),
      activeTrack:current, captionsEnabled:current.enabled, renderedCaptionVisible:rendered};
    const serialized = JSON.stringify(snapshot);
    if (serialized !== lastTraceState) {
      const age = item => item ? Date.now() - item.at : Infinity;
      const source = age(lastWrappedMutation) < 350 ? lastWrappedMutation.source :
        age(lastRehydration) < 350 ? 'youtube-rehydration' : 'youtube-internal';
      record('CAPTION_STATE_OBSERVED', {...snapshot, source,
        wrappedSetOption:age(lastWrappedMutation) < 350,
        fromPlayerResponseRehydration:age(lastRehydration) < 350,
        newCaptionModelInstance:lastRehydration?.captionModelIdentity === snapshot.captionModelIdentity &&
          age(lastRehydration) < 350,
        listenerIdentity:'yttr-trace-sampler'});
      lastTraceState = serialized;
    }
    traceTimer = setTimeout(traceSample, 100);
  }

  for (const eventName of ['yt-navigate-start', 'yt-navigate-finish', 'ytaf-page-update']) {
    document.addEventListener?.(eventName, () => {
      const p = player();
      let current;
      try { current = safeTrack(p?.getOption?.('captions', 'track')); }
      catch { current = safeTrack(null); }
      record('NAVIGATION_EVENT', {videoId:videoId(p), eventSource:eventName,
        resultingState:current, captionsEnabled:current.enabled,
        listenerIdentity:`yttr-navigation-${eventName}`, ...contextDetails(p)});
    }, true);
  }

  // Observe the actual transport proven on this TV. Never rewrite a request,
  // touch media, or export URL/token values. Fall back only for the same video
  // while our EN->TR translation is still selected.
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, rawUrl) {
    if (mode === 'OFF' || (typeof rawUrl === 'string' && !rawUrl.includes('/api/timedtext'))) {
      return originalOpen.apply(this, arguments);
    }
    try {
      const url = new URL(rawUrl, location.href);
      if (mode !== 'OFF' && url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext' &&
          url.searchParams.get('tlang') === 'tr') {
        const p = player(), id = videoId(p);
        const sourceUrl = () => captionModel(p?.getPlayerResponse?.())?.captionTracks?.find(t =>
          t.languageCode === url.searchParams.get('lang') && (t.kind || '') === (url.searchParams.get('kind') || ''))?.baseUrl;
        const requestSource = sourceUrl();
        let aborted = false;
        this.addEventListener('abort', () => {aborted = true;}, {once:true});
        this.addEventListener('loadend', () => {
          try {
            if (aborted) return; // Player cancellations during seek/next are not HTTP failures.
            const readable = !this.responseType || this.responseType === 'text';
            const count = readable ? cueCount(this.responseText) : null;
            const ok = this.status >= 200 && this.status < 300 && (!readable || count > 0);
            record(ok ? 'TR_REQUEST_OK' : 'TR_REQUEST_FAILED', {status:this.status, cues:count});
            const track = p?.getOption?.('captions', 'track');
            if (!ok && mode !== 'OFF' && player() === p && videoId(p) === id &&
                requestSource && sourceUrl() === requestSource &&
                track?.translationLanguage?.languageCode === 'tr' && track.languageCode === url.searchParams.get('lang')) {
              auto.failed(p, id);
              applyAutoTrack(p, {languageCode:track.languageCode, kind:track.kind}, {
                playerGeneration:auto.status().playerGeneration,
                listenerIdentity:'auto-tr-source-fallback'});
              record('FALLBACK_SOURCE');
            }
          } catch { record('DIAGNOSTIC_PASSTHROUGH'); }
        }, {once:true});
      }
    } catch { /* Instrumentation cannot block playback. */ }
    return originalOpen.apply(this, arguments);
  };

  window.__YTTR_POC__ = {
    version: 2,
    status: () => ({mode, targetLanguage:'tr', captionsEnabledPreference, auto:auto.status(),
      trace:{active:traceTimer !== null, until:traceUntil || null, eventCount:events.length},
      events:events.map(e => ({...e}))}),
    startTrace(durationMs = 60000) {
      const bounded = Math.max(10000, Math.min(Number(durationMs) || 60000, 1800000));
      if (traceTimer !== null) clearTimeout(traceTimer);
      events.length = 0; lastTraceState = ''; traceUntil = Date.now() + bounded;
      record('TRACE_STARTED', {durationMs:bounded}); traceSample();
      return {durationMs:bounded};
    },
    armNextTrace(durationMs = 1800000) {
      const bounded = Math.max(10000, Math.min(Number(durationMs) || 1800000, 1800000));
      localStorage.setItem(TRACE_KEY, JSON.stringify({expiresAt:Date.now() + 30000, durationMs:bounded}));
      return {armed:true, durationMs:bounded};
    },
    stopTrace,
    setMode(next) {
      if (!['OFF', 'MANUAL', 'AUTO_TR'].includes(next)) throw new Error('INVALID_POC_MODE');
      // Preference belongs to the app/user, never a video ID or a track instance.
      mode = next;
      if (mode === 'AUTO_TR') captionsEnabledPreference = true;
      savePreference();
      if (mode === 'AUTO_TR') auto.start(); else auto.stop();
      record('MODE_CHANGED', {mode});
      return {mode, reloadRequired:mode !== 'AUTO_TR'};
    },
    async translate() {
      if (mode === 'OFF') return {error:'POC_OFF'};
      const p = player(), id = videoId(p);
      const model = captionModel(p?.getPlayerResponse?.());
      if (model?.captionTracks?.some(t => t.languageCode === 'tr')) {
        p.setOption('captions', 'track', {languageCode:'tr'});
        return {selected:'native-tr'};
      }
      const source = englishSource(model);
      if (!source) return {error:'NO_ENGLISH_SOURCE'};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(withTurkishTarget(source.baseUrl), {signal:controller.signal});
        const text = await response.text(), cues = cueCount(text);
        if (!response.ok || !cues) {
          record(!response.ok ? 'HTTP_REJECTED' : 'NO_TRANSLATED_DATA', {status:response.status});
          return {error:!response.ok ? 'HTTP_REJECTED' : 'NO_TRANSLATED_DATA', status:response.status};
        }
        if (mode === 'OFF' || player() !== p || videoId(p) !== id) return {error:'STALE_VIDEO'};
        p.loadModule('captions');
        p.setOption('captions', 'track', {languageCode:source.languageCode, kind:source.kind,
          translationLanguage:{languageCode:'tr', languageName:'Türkçe'}});
        record('TR_SELECTED', {status:response.status, cues});
        return {selected:'en->tr', status:response.status, cues};
      } catch { record('PROBE_FAILED'); return {error:'PROBE_FAILED'}; }
      finally { clearTimeout(timer); }
    }
  };
  try {
    const armed = JSON.parse(localStorage.getItem(TRACE_KEY) || 'null');
    if (armed?.expiresAt > Date.now()) {
      localStorage.removeItem(TRACE_KEY);
      window.__YTTR_POC__.startTrace(armed.durationMs);
    }
  } catch { /* Trace remains opt-in. */ }
  if (mode === 'AUTO_TR') auto.start();
}

if (typeof window !== 'undefined') install();
