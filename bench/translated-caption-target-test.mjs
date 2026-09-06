import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseTranslatedCaptionTrack, ensureTranslationTarget } from '../src/translated-caption-target.js';

const source = (overrides = {}) => ({
  languageCode: 'en', kind: 'asr', isTranslatable: true,
  baseUrl: 'https://www.youtube.com/api/timedtext?signed=value', ...overrides
});
const response = (tracks, languages = []) => ({
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, translationLanguages: languages } }
});

test('adds a missing translation target without changing caption tracks or signed URLs', () => {
  const english = source();
  const playerResponse = response([english], [{ languageCode: 'de' }]);
  assert.equal(ensureTranslationTarget(playerResponse, 'tr', 'Türkçe'), true);
  const model = playerResponse.captions.playerCaptionsTracklistRenderer;
  assert.equal(model.captionTracks[0], english);
  assert.equal(model.captionTracks[0].baseUrl, 'https://www.youtube.com/api/timedtext?signed=value');
  assert.deepEqual(model.translationLanguages.at(-1), {
    languageCode: 'tr', languageName: { simpleText: 'Türkçe' }
  });
  assert.equal(ensureTranslationTarget(playerResponse, 'tr', 'Türkçe'), false);
});

test('prefers native target captions and otherwise chooses a translatable source', () => {
  const native = source({ languageCode: 'tr', kind: '', isTranslatable: false });
  const nativeResponse = response([source(), native]);
  assert.deepEqual(chooseTranslatedCaptionTrack(nativeResponse.captions.playerCaptionsTracklistRenderer, 'tr'), {
    track: { languageCode: 'tr', kind: '' }, native: true
  });
  assert.equal(ensureTranslationTarget(nativeResponse, 'tr', 'Türkçe'), false);

  const translated = chooseTranslatedCaptionTrack(response([source()]).captions.playerCaptionsTracklistRenderer, 'tr');
  assert.equal(translated.native, false);
  assert.equal(translated.track.translationLanguage.languageCode, 'tr');
});

test('captionless and non-translatable responses pass through', () => {
  assert.equal(ensureTranslationTarget({}, 'tr', 'Türkçe'), false);
  assert.equal(ensureTranslationTarget(response([source({ isTranslatable: false })]), 'tr', 'Türkçe'), false);
});
