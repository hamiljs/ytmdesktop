// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAuthor,
  cleanTitle,
  cleanTrack,
  chosenByUser,
} from '../src/main/integrations/last-fm/track-name.mts';

const AUDIO = 0;
const VIDEO = 1;
const UPLOAD = -1;

test('official audio tracks pass through, minus a Topic suffix', () => {
  assert.deepEqual(
    cleanTrack({
      title: 'One More Time',
      author: 'Daft Punk',
      album: 'Discovery',
      videoType: AUDIO,
    }),
    {
      artist: 'Daft Punk',
      track: 'One More Time',
      album: 'Discovery',
    },
  );
  assert.equal(cleanAuthor('Daft Punk - Topic'), 'Daft Punk');
});

test('official audio keeps bracketed words that are part of the real title', () => {
  const t = cleanTrack({
    title: 'Song (Official Video Edit)',
    author: 'X',
    album: null,
    videoType: AUDIO,
  });
  assert.equal(t.track, 'Song (Official Video Edit)');
});

test('VEVO channels get their spaces back', () => {
  assert.equal(cleanAuthor('DaftPunkVEVO'), 'Daft Punk');
  assert.equal(cleanAuthor('TaylorSwiftVEVO'), 'Taylor Swift');
  assert.equal(cleanAuthor('Taylor Swift VEVO'), 'Taylor Swift');
});

test('music video noise is stripped from the title', () => {
  assert.equal(cleanTitle('One More Time (Official Video)'), 'One More Time');
  assert.equal(
    cleanTitle('One More Time [Official Music Video]'),
    'One More Time',
  );
  assert.equal(
    cleanTitle('One More Time (Official HD Video)'),
    'One More Time',
  );
  assert.equal(cleanTitle('One More Time (Lyrics)'), 'One More Time');
  assert.equal(cleanTitle('One More Time | Official Audio'), 'One More Time');
  assert.equal(
    cleanTitle('One More Time (Official Visualizer)'),
    'One More Time',
  );
});

test('real version markers survive', () => {
  assert.equal(
    cleanTitle('Heroes (Remastered 2017)'),
    'Heroes (Remastered 2017)',
  );
  assert.equal(cleanTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  assert.equal(cleanTitle('Song (feat. Someone)'), 'Song (feat. Someone)');
  assert.equal(cleanTitle('Song (Acoustic)'), 'Song (Acoustic)');
});

test('Artist - Track titles split when the channel matches', () => {
  assert.deepEqual(
    cleanTrack({
      title: 'Daft Punk - One More Time (Official Video)',
      author: 'DaftPunkVEVO',
      album: null,
      videoType: VIDEO,
    }),
    { artist: 'Daft Punk', track: 'One More Time', album: undefined },
  );
});

test('Artist - Track titles split on label channels', () => {
  assert.deepEqual(
    cleanTrack({
      title: 'Bicep - Glue',
      author: 'Ninja Tune Records',
      album: null,
      videoType: UPLOAD,
    }),
    { artist: 'Bicep', track: 'Glue', album: undefined },
  );
});

test('a dash inside a song title on an artist channel does not split', () => {
  assert.deepEqual(
    cleanTrack({
      title: 'Wake Up - Part 2',
      author: 'Arcade Fire',
      album: null,
      videoType: VIDEO,
    }),
    { artist: 'Arcade Fire', track: 'Wake Up - Part 2', album: undefined },
  );
});

test("radio picks are not the listener's choice; the radio seed is", () => {
  assert.equal(chosenByUser('RDAMVMR-hYM3BqTbA', 'R-hYM3BqTbA'), true);
  assert.equal(chosenByUser('RDAMVMR-hYM3BqTbA', 'qFdoMMR-7fc'), false);
  assert.equal(chosenByUser('RDTMAK5uy_abc', 'qFdoMMR-7fc'), false);
  assert.equal(chosenByUser('PLabc123', 'qFdoMMR-7fc'), true);
  assert.equal(chosenByUser(null, 'qFdoMMR-7fc'), true);
});
