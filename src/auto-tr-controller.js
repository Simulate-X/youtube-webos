// Selection policy and bounded lifecycle controller. No DOM clicks or URL replay.
export function chooseTurkishTrack(model) {
  const tracks = model?.captionTracks;
  if (!Array.isArray(tracks)) return null;
  const native = tracks.find(t => t?.languageCode === 'tr' && t.kind !== 'asr') ||
    tracks.find(t => t?.languageCode === 'tr');
  const available = tracks.filter(t => t?.isTranslatable === true && typeof t.baseUrl === 'string');
  const english = available.filter(t => /^en(?:-|$)/.test(t.languageCode || ''));
  const source = native || english.find(t => t.kind !== 'asr') || english[0] ||
    available.find(t => t.kind !== 'asr') || available[0];
  if (!source) return null;
  const track = {languageCode:source.languageCode, kind:source.kind || ''};
  if (!native) track.translationLanguage = {languageCode:'tr', languageName:'Türkçe'};
  return {track, native:!!native};
}

export function matchesTurkishTrack(current, target) {
  return current?.languageCode === target?.languageCode &&
    (current?.kind || '') === (target?.kind || '') &&
    (current?.translationLanguage?.languageCode || '') === (target?.translationLanguage?.languageCode || '');
}

export function createAutoTrController({getPlayer, record = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, maxAttempts = 8, applyTrack,
  describeContext = () => ({}), isUserInitiatedChange = () => false,
  isAutoSelectionEnabled = () => true, onUserCaptionChange = () => {}}) {
  let enabled = false, timer = null, boundPlayer = null, state = null, generation = 0;
  const events = ['onApiChange', 'onStateChange', 'onVideoDataChange'];
  const wake = () => {
    if (!enabled || timer !== null) return;
    timer = schedule(() => {timer = null; tick(); wakeAfter();}, 100);
  };
  const wakeAfter = () => {
    if (enabled && timer === null) timer = schedule(() => {timer = null; tick(); wakeAfter();}, 1000);
  };
  function bind(p) {
    if (p === boundPlayer) return;
    for (const event of events) {
      try { boundPlayer?.removeEventListener?.(event, wake); } catch { /* old player */ }
    }
    boundPlayer = p;
    for (const event of events) {
      try { p?.addEventListener?.(event, wake); } catch { /* polling fallback */ }
    }
  }
  function tick() {
    if (!enabled) return;
    try {
      const p = getPlayer();
      bind(p);
      const response = p?.getPlayerResponse?.();
      const id = p?.getVideoData?.()?.video_id;
      // During playlist transitions the old response can outlive the new ID.
      if (!id || response?.videoDetails?.videoId !== id) return;
      const model = response?.captions?.playerCaptionsTracklistRenderer;
      const context = describeContext(p, response, model) || {};
      // Include source URL only in private memory: refreshed models can change
      // validity without changing language codes. Never put this signature in logs.
      const signature = JSON.stringify(model?.captionTracks?.map(t =>
        [t?.languageCode, t?.kind, t?.vssId, t?.isTranslatable, t?.baseUrl]) || []);
      if (!state || state.player !== p || state.id !== id || state.signature !== signature) {
        state = {player:p, id, signature, attempts:0, moduleRequested:false,
          nextAt:0, blocked:false, selected:false, userOverride:false,
          generation:++generation, model, reason:'WAITING_FOR_CAPTIONS'};
        record('AUTO_CONTEXT', {videoId:id, playerGeneration:state.generation,
          listenerIdentity:`auto-tr-controller-g${state.generation}`, ...context});
      } else if (state.model !== model) {
        record('CAPTION_MODEL_INSTANCE_CHANGED', {videoId:id, playerGeneration:state.generation,
          source:'youtube-rehydration', wrappedSetOption:false,
          listenerIdentity:`auto-tr-controller-g${state.generation}`, ...context});
        state.model = model;
        // A replacement model invalidates the old selection object. Preserve a
        // confirmed TR intent, but never revive captions after a user override.
        if (state.selected && !state.userOverride) {
          state.selected = false;
          state.modelReapplyPending = true;
          state.nextAt = 0;
        }
      }
      const target = chooseTurkishTrack(model);
      if (!target) {state.reason = 'NO_USABLE_CAPTIONS'; return;}
      if (typeof p.getOption !== 'function' || typeof p.setOption !== 'function') return;
      const current = p.getOption('captions', 'track');
      const currentKey = JSON.stringify([current?.languageCode || '', current?.kind || '',
        current?.translationLanguage?.languageCode || '']);
      const previousObservedKey = state.observedTrackKey;
      state.observedTrackKey = currentKey;
      if (!isAutoSelectionEnabled()) {
        // OFF is an app/user preference, not a video-generation override. A
        // later explicit ON selection can re-enable automatic selection, but
        // the first state observed after navigation is never treated as intent.
        if (previousObservedKey !== undefined && previousObservedKey !== currentKey &&
            Object.keys(current || {}).length > 0 && isUserInitiatedChange(p, id, current)) {
          onUserCaptionChange(current, {player:p, videoId:id, source:'user'});
          state.userOverride = true; state.reason = 'USER_OVERRIDE';
        } else {
          state.selected = false; state.userOverride = true; state.reason = 'USER_DISABLED';
        }
        return;
      }
      if (matchesTurkishTrack(current, target.track)) {
        if (state.userOverride) {
          record('USER_TARGET_ACCEPTED', {videoId:id, playerGeneration:state.generation,
            source:'user', requestedState:target.track, resultingState:current,
            wrappedSetOption:false, listenerIdentity:`auto-tr-controller-g${state.generation}`,
            ...context});
          state.userOverride = false;
        }
        if (!state.selected) record('AUTO_SELECTED', {videoId:id, playerGeneration:state.generation,
          native:target.native, listenerIdentity:`auto-tr-controller-g${state.generation}`});
        state.selected = true; state.modelReapplyPending = false; state.reason = 'SELECTED'; return;
      }
      if (state.blocked) {state.reason = 'REQUEST_FAILED'; return;}
      // Public setter mutations are marked by userAction(). YouTube can also
      // replace its internal caption state during initialization without using
      // that setter; only that observed drift is eligible for bounded recovery.
      if (state.userOverride) {state.reason = 'USER_OVERRIDE'; return;}
      if (state.selected) {
        // YouTube's caption menu bypasses the public setter, but late player
        // initialization can do the same. Only a state change correlated with
        // a real recent user input is authoritative; otherwise this remains a
        // bounded lifecycle recovery.
        if (isUserInitiatedChange(p, id, current)) {
          onUserCaptionChange(current, {player:p, videoId:id, source:'user'});
          record('USER_CAPTION_STATE_ACCEPTED', {videoId:id, playerGeneration:state.generation,
            source:'user', requestedState:current || {},
            previousState:target.track, resultingState:current || {},
            wrappedSetOption:false, listenerIdentity:`auto-tr-controller-g${state.generation}`,
            ...context});
          state.selected = false; state.userOverride = true; state.reason = 'USER_OVERRIDE'; return;
        }
        record('CAPTION_STATE_DRIFT', {videoId:id, playerGeneration:state.generation,
          source:'youtube-lifecycle', requestedState:target.track,
          previousState:target.track, resultingState:current || {},
          wrappedSetOption:false, listenerIdentity:`auto-tr-controller-g${state.generation}`,
          ...context});
        state.selected = false;
      }
      if (state.attempts >= maxAttempts) {state.reason = 'RETRY_EXHAUSTED'; return;}
      if (now() < state.nextAt) return;
      state.attempts++;
      state.nextAt = now() + Math.min(250 * 2 ** (state.attempts - 1), 2000);
      if (!state.moduleRequested) {
        // Once per model. An empty tracklist is valid for ASR-only videos.
        p.loadModule?.('captions');
        state.moduleRequested = true; state.reason = 'INITIALIZING'; return;
      }
      const options = p.getOptions?.('captions');
      if (Array.isArray(options) && !options.includes('track')) {state.reason = 'INITIALIZING'; return;}
      const mutationContext = {videoId:id, playerGeneration:state.generation,
        listenerIdentity:`auto-tr-controller-g${state.generation}`, ...context};
      if (applyTrack) applyTrack(p, target.track, mutationContext);
      else p.setOption('captions', 'track', target.track);
      if (state.modelReapplyPending) {
        record('AUTO_MODEL_REAPPLY', {...mutationContext, source:'auto', requestedState:target.track});
        state.modelReapplyPending = false;
      }
      state.reason = 'VERIFYING';
      record('AUTO_SELECT_ATTEMPT', {...mutationContext, native:target.native, attempt:state.attempts});
    } catch {
      // Attempts are consumed before loadModule/setOption: throwing APIs cannot
      // generate an infinite retry loop or affect the underlying video.
      if (state) state.reason = 'API_NOT_READY';
    }
  }
  return {
    start() {if (enabled) return; enabled = true; state = null; tick(); wake();},
    stop() {enabled = false; if (timer !== null) cancel(timer); timer = null; bind(null); state = null;},
    notify: wake,
    userAction(p, id, requested) {
      if (state?.player === p && state.id === id) {
        if (requested !== undefined) onUserCaptionChange(requested, {player:p, videoId:id, source:'user'});
        state.userOverride = true; state.reason = 'USER_OVERRIDE';
      }
    },
    // Request failure is terminal for this model. Do not fight source fallback.
    failed(p, id) {
      if (state?.player === p && state.id === id) {
        state.blocked = true;
        state.selected = false;
        state.reason = 'REQUEST_FAILED';
      }
    },
    status: () => ({enabled, videoId:state?.id, playerGeneration:state?.generation,
      attempts:state?.attempts || 0, selected:state?.selected || false,
      userOverride:state?.userOverride || false, reason:state?.reason || 'IDLE'}),
    tick
  };
}
