import test from 'node:test';
import assert from 'node:assert/strict';
import {getHostModelOverrides, getModelsForHost, getCodebuddyCustomSiteLabel, getCodebuddyCustomSiteLabels} from '../src/services/codebuddy/config.js';
import {getCodebuddyAdminOptions} from '../src/routes/dashboard-codebuddy.js';

test('CodeBuddy model overrides are read from environment JSON', () => {
    const saved = process.env.CODEBUDDY_MODEL_OVERRIDES;
    process.env.CODEBUDDY_MODEL_OVERRIDES = JSON.stringify({
        'https://custom-codebuddy.example.com': [
            {id: 'custom:glm51', name: 'GLM-5.1', tools: true, vision: false},
            {id: 'custom:kimi', name: 'Kimi Custom', vision: true}
        ]
    });

    try {
        assert.deepEqual(getHostModelOverrides()['custom-codebuddy.example.com'], [
            {id: 'custom:glm51', name: 'GLM-5.1', tools: true, vision: false, maxOutputTokens: null},
            {id: 'custom:kimi', name: 'Kimi Custom', tools: true, vision: true, maxOutputTokens: null}
        ]);
        assert.deepEqual(getModelsForHost('https://custom-codebuddy.example.com'), [
            {id: 'custom:glm51', name: 'GLM-5.1', tools: true, vision: false, maxOutputTokens: null},
            {id: 'custom:kimi', name: 'Kimi Custom', tools: true, vision: true, maxOutputTokens: null}
        ]);
    } finally {
        if (saved === undefined) delete process.env.CODEBUDDY_MODEL_OVERRIDES;
        else process.env.CODEBUDDY_MODEL_OVERRIDES = saved;
    }
});

test('CodeBuddy custom site labels and admin model options are environment-driven', () => {
    const saved = {
        CODEBUDDY_DEFAULT_BASE_URL: process.env.CODEBUDDY_DEFAULT_BASE_URL,
        CODEBUDDY_EXTRA_BASE_URLS: process.env.CODEBUDDY_EXTRA_BASE_URLS,
        CODEBUDDY_CUSTOM_SITE_LABELS: process.env.CODEBUDDY_CUSTOM_SITE_LABELS,
        CODEBUDDY_MODEL_OVERRIDES: process.env.CODEBUDDY_MODEL_OVERRIDES
    };
    process.env.CODEBUDDY_DEFAULT_BASE_URL = 'https://custom-codebuddy.example.com';
    delete process.env.CODEBUDDY_EXTRA_BASE_URLS;
    process.env.CODEBUDDY_CUSTOM_SITE_LABELS = JSON.stringify({
        'custom-codebuddy.example.com': 'Private Model Hub'
    });
    process.env.CODEBUDDY_MODEL_OVERRIDES = JSON.stringify({
        'custom-codebuddy.example.com': [
            {id: 'private:sonnet', name: 'Private Sonnet', tools: true, vision: true}
        ]
    });

    try {
        assert.deepEqual(getCodebuddyCustomSiteLabels(), {'custom-codebuddy.example.com': 'Private Model Hub'});
        assert.equal(getCodebuddyCustomSiteLabel('https://custom-codebuddy.example.com'), 'Private Model Hub');
        const options = getCodebuddyAdminOptions();
        assert.equal(options[0].label, 'Private Model Hub');
        assert.deepEqual(options[0].models, [
            {id: 'private:sonnet', name: 'Private Sonnet', tools: true, vision: true, maxOutputTokens: null}
        ]);
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
