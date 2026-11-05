const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProjectRepository, ProjectStorageError } = require('../storage/projectRepository.cjs');

const asset = (id, kind = 'image') => ({
  id,
  kind,
  sourceKind: 'legacy-inline',
  locator: kind === 'image'
    ? { previewRef: 'data:image/png;base64,fixture', originalRef: 'data:image/png;base64,fixture', mimeType: 'image/png' }
    : { fileRef: 'data:application/octet-stream;base64,fixture', mimeType: 'application/octet-stream' },
  metadata: {},
});

const documentWith = stored => ({
  format: 'artflow-project',
  version: 2,
  assets: [stored.asset],
  boards: [{
    id: 'board',
    name: 'Board',
    panOffset: { x: 0, y: 0 },
    zoom: 1,
    canvasBackgroundColor: '#111827',
    operationHistory: [],
    operationHistoryIndex: -1,
  }],
  nodes: [{
    id: 'node',
    boardId: 'board',
    assetId: stored.asset.id,
    nodeType: 'image',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    zIndex: 0,
    properties: {},
  }],
});

const main = async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artflow-inventory-'));
  const repository = await ProjectRepository.open(projectRoot);
  try {
    const shared = Buffer.from('shared-bytes');
    const kept = await repository.putAsset({ asset: asset('kept-image'), bytes: shared, originalName: 'kept.png' });
    const spare = await repository.putAsset({ asset: asset('spare-image'), bytes: shared, originalName: 'spare.png' });
    const alone = await repository.putAsset({ asset: asset('alone-image'), bytes: Buffer.from('alone-bytes'), originalName: 'alone.png' });
    repository.saveProjectDocument(documentWith(kept));

    const page = repository.listAssetInventory({ offset: 0, limit: 50 });
    assert.equal(page.totalAssets, 3);
    assert.equal(page.uniqueBlobs, 2);
    assert.equal(page.unreferencedAssets, 2);
    assert.equal(page.items.find(item => item.id === 'kept-image').usage, 'document');
    assert.equal(page.items.find(item => item.id === 'spare-image').usage, 'none');
    assert.equal(page.items.find(item => item.id === 'kept-image').hashPrefix.length, 12);
    assert.equal(JSON.stringify(page).includes(kept.contentHash), false);

    const unused = repository.listAssetInventory({ unreferencedOnly: true, limit: 10 });
    assert.deepEqual(unused.items.map(item => item.id).sort(), ['alone-image', 'spare-image']);

    const blocked = await repository.reclaimUnreferencedAssets({ assetIds: ['kept-image', 'spare-image'] });
    assert.deepEqual(blocked.kept, ['kept-image']);
    assert.deepEqual(blocked.removed, ['spare-image']);
    assert.equal(blocked.freedBytes, 0);
    assert.equal(repository.getAsset('spare-image'), null);
    assert.deepEqual(await repository.readAssetBytes('kept-image'), shared);

    const protectedLive = await repository.reclaimUnreferencedAssets({
      assetIds: ['alone-image'],
      protectIds: ['alone-image'],
    });
    assert.deepEqual(protectedLive.removed, []);
    assert.deepEqual(protectedLive.kept, ['alone-image']);

    await repository.stageImport({
      id: '11111111-1111-4111-8111-111111111111',
      asset: asset('alone-image'),
      bytes: Buffer.from('staging'),
      originalName: 'alone.png',
    });
    const duringImport = await repository.reclaimUnreferencedAssets({ assetIds: ['alone-image'] });
    assert.deepEqual(duringImport.kept, ['alone-image']);

    await repository.updateImportJob({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'cancelled',
      progress: 0,
    });
    const freed = await repository.reclaimUnreferencedAssets({ assetIds: ['alone-image'] });
    assert.deepEqual(freed.removed, ['alone-image']);
    assert.equal(freed.freedBytes, Buffer.from('alone-bytes').byteLength);
    await assert.rejects(() => repository.readAssetBytes('alone-image'));

    const renamed = repository.renameAssetNames({
      changes: [
        { id: 'kept-image', name: '  hero.png  ' },
        { id: 'missing-image', name: 'gone.png' },
      ],
    });
    assert.deepEqual(renamed.renamed, ['kept-image']);
    assert.deepEqual(renamed.missing, ['missing-image']);
    assert.equal(repository.listAssetInventory({ limit: 10 }).items.find(item => item.id === 'kept-image').originalName, 'hero.png');
    assert.deepEqual(await repository.readAssetBytes('kept-image'), shared);
    assert.throws(
      () => repository.renameAssetNames({ changes: [{ id: 'kept-image', name: '../secret.png' }] }),
      ProjectStorageError,
    );
    assert.throws(
      () => repository.renameAssetNames({ changes: [] }),
      ProjectStorageError,
    );

    assert.throws(
      () => repository.listAssetInventory({ limit: 0 }),
      ProjectStorageError,
    );
    await assert.rejects(
      () => repository.reclaimUnreferencedAssets({ assetIds: [] }),
      ProjectStorageError,
    );

    const preload = await fs.readFile(path.join(__dirname, '../preload.cjs'), 'utf8');
    const mainSource = await fs.readFile(path.join(__dirname, '../main.cjs'), 'utf8');
    const plugin = await fs.readFile(path.join(__dirname, '../builtin-plugins/asset-library/index.tsx'), 'utf8');
    assert.match(preload, /listAssetInventory: request => ipcRenderer\.invoke\(CHANNELS\.listAssetInventory, request\)/);
    assert.match(mainSource, /listAssetInventory: 'artflow-storage:list-asset-inventory'/);
    assert.match(mainSource, /reclaimUnreferencedAssets: 'artflow-storage:reclaim-unreferenced-assets'/);
    assert.match(mainSource, /renameAssetNames: 'artflow-app:rename-asset-names'/);
    assert.match(preload, /renameAssetNames: \(request\) => ipcRenderer\.invoke\(CHANNELS\.renameAssetNames, request\)/);
    // 18 = 原有 15 + 「最近工程」的 list / open / clear 三条（P3 桌面化能力，均为 sender-checked）。
    assert.equal((mainSource.match(/artflow-storage:/g) || []).length, 18);
    assert.match(mainSource, /assertTrustedRenderer\(event\)/);
    assert.doesNotMatch(plugin, /artflowStorage|ipcRenderer|node:fs|node:sqlite/);
    console.log('asset inventory checks: ok');
  } finally {
    repository.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
