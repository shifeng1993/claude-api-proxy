import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const root = process.cwd();

function readProjectFile(path) {
    return readFileSync(join(root, path), 'utf8');
}

test('legacy cluster deployment and broadcast sync are removed', () => {
    assert.equal(existsSync(join(root, 'ecosystem.cluster.config.cjs')), false);
    assert.equal(existsSync(join(root, 'docs/nginx-cluster.md')), false);
    assert.equal(existsSync(join(root, 'src/services/shared/cluster-broadcaster.js')), false);

    const files = [
        'src/server.js',
        'src/routes/dashboard-frontend.js',
        'src/routes/dashboard-codebuddy.js',
        'scripts/deploy.mjs',
        '.env.example',
        'README.md',
        '本地安装部署.md'
    ];

    for (const file of files) {
        const content = readProjectFile(file);
        assert.equal(content.includes('cluster-broadcaster'), false, file);
        assert.equal(content.includes('/internal/sync'), false, file);
        assert.equal(content.includes('ecosystem.cluster.config.cjs'), false, file);
        assert.equal(content.includes('CLUSTER_INTERNAL_SECRET'), false, file);
        assert.equal(content.includes('CLUSTER_BASE_PORT'), false, file);
        assert.equal(content.includes('CLUSTER_WORKER_COUNT'), false, file);
        assert.equal(content.includes('CLUSTER_PORTS'), false, file);
    }
});
