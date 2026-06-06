import test from 'node:test';
import assert from 'node:assert/strict';
import {repairMojibakeFilename} from '../src/services/feedback.js';

test('repairMojibakeFilename restores UTF-8 names parsed as latin1', () => {
    const mojibake = Buffer.from('测试附件.png', 'utf8').toString('latin1');
    assert.equal(repairMojibakeFilename(mojibake), '测试附件.png');
});

test('repairMojibakeFilename leaves normal western names unchanged', () => {
    assert.equal(repairMojibakeFilename('resume.pdf'), 'resume.pdf');
    assert.equal(repairMojibakeFilename('résumé.pdf'), 'résumé.pdf');
});
