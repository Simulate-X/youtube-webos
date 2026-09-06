export function captionModel(response) {
  return response?.captions?.playerCaptionsTracklistRenderer;
}

export function chooseTranslatedCaptionTrack(model, targetLanguage) {
  const tracks = model?.captionTracks;
  if (!Array.isArray(tracks) || !targetLanguage) return null;

  const native = tracks.find((track) => track?.languageCode === targetLanguage && track.kind !== 'asr') ||
    tracks.find((track) => track?.languageCode === targetLanguage);
  if (native) return { track: { languageCode: native.languageCode, kind: native.kind || '' }, native: true };

  const sources = tracks.filter((track) => track?.isTranslatable === true && typeof track.baseUrl === 'string');
  const english = sources.filter((track) => /^en(?:-|$)/.test(track.languageCode || ''));
  const source = english.find((track) => track.kind !== 'asr') || english[0] ||
    sources.find((track) => track.kind !== 'asr') || sources[0];
  if (!source) return null;

  return {
    track: {
      languageCode: source.languageCode,
      kind: source.kind || '',
      translationLanguage: { languageCode: targetLanguage }
    },
    native: false
  };
}

export function ensureTranslationTarget(response, targetLanguage, languageName = targetLanguage) {
  const model = captionModel(response);
  const target = chooseTranslatedCaptionTrack(model, targetLanguage);
  if (!target || target.native || !Array.isArray(model.translationLanguages) ||
      model.translationLanguages.some((language) => language?.languageCode === targetLanguage)) return false;

  model.translationLanguages = [
    ...model.translationLanguages,
    { languageCode: targetLanguage, languageName: { simpleText: languageName } }
  ];
  return true;
}
