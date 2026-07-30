/* NeuMind — マインドマップエディタ */
'use strict';

// ============================================================
// バックエンド (Notion / デモ)
// ============================================================
const IS_EXT = location.protocol === 'chrome-extension:';
// 拡張版はNotion直結のためデモモードを持たない。
// (以前のバージョンでフラグだけ残ってしまった人のために掃除もする)
if (IS_EXT) localStorage.removeItem('mm_demo');
const DEMO = !IS_EXT && localStorage.getItem('mm_demo') === '1';
const PARAMS = new URLSearchParams(location.search);
// 共有リンク: /?s=<キー> の1本だけ。閲覧か編集かはサーバーが判定する
const SHARE_KEY = PARAMS.get('s') || null;
let SHARE_ROLE = null;   // 'view' | 'edit'
let SHARE_FILE = null;   // 共有されたマップのID
let RO = false;          // 閲覧専用モード
const SNAPSHOT = null;   // (旧スナップショット共有の名残。常にnull)

// SVGアイコン (絵文字は使わない)
const ICON = {
  link: '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="11" height="11"><path d="M4 4h16v13H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h8M8 12.5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none"><path d="M3.6 7.1a1.9 1.9 0 0 1 1.9-1.9h3.9l2 2.2h7.1a1.9 1.9 0 0 1 1.9 1.9v8.8a1.9 1.9 0 0 1-1.9 1.9H5.5a1.9 1.9 0 0 1-1.9-1.9z" stroke="#1d1d1f" stroke-width="1.5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none"><path d="M8 12l9.5-5.5M8 12h9.5M8 12l9.5 5.5" stroke="#1d1d1f" stroke-width="1.6"/><circle cx="7.5" cy="12" r="3.1" fill="#1d1d1f"/><circle cx="17.5" cy="6.5" r="1.8" fill="#1d1d1f"/><circle cx="17.5" cy="12" r="1.8" fill="#1d1d1f"/><circle cx="17.5" cy="17.5" r="1.8" fill="#1d1d1f"/></svg>',
};

async function jfetch(url, opts = {}) {
  if (SHARE_KEY) opts = { ...opts, headers: { ...(opts.headers || {}), 'x-share-key': SHARE_KEY } };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.status); e.status = res.status; throw e; }
  return data;
}

const notionBackend = {
  name: 'notion',
  status: () => jfetch('/api/status'),
  saveToken: (token) => jfetch('/api/token', { method: 'POST', body: JSON.stringify({ token }) }),
  clearToken: () => jfetch('/api/token', { method: 'DELETE' }),
  setupDetect: () => jfetch('/api/setup/detect', { method: 'POST' }),
  syncOutline: (fileId) => jfetch('/api/outline', { method: 'POST', body: JSON.stringify({ fileId }) }),
  listFiles: async () => (await jfetch('/api/files')).files,
  getFile: async (id) => (await jfetch('/api/files/' + id)).file,
  createFile: (data) => jfetch('/api/files', { method: 'POST', body: JSON.stringify(data) }),
  updateFile: (id, data) => jfetch('/api/files/' + id, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteFile: (id) => jfetch('/api/files/' + id, { method: 'DELETE' }),
  listNodes: async (fileId) => (await jfetch('/api/nodes/' + fileId)).nodes,
  createNode: async (data) => (await jfetch('/api/nodes', { method: 'POST', body: JSON.stringify(data) })).node,
  updateNode: async (id, data) => (await jfetch('/api/nodes/' + id, { method: 'PATCH', body: JSON.stringify(data) })).node,
  deleteNode: (id) => jfetch('/api/nodes/' + id, { method: 'DELETE' }),
  restoreNode: async (id) => (await jfetch('/api/nodes/' + id + '/restore', { method: 'POST' })).node,
  refreshNode: async (id) => (await jfetch('/api/nodes/' + id + '/refresh')).node,
  uploadImage: async (id, blob, filename) => {
    const res = await fetch(`/api/nodes/${id}/image`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'image/png',
        'X-Filename': encodeURIComponent(filename),
        ...(SHARE_KEY ? { 'x-share-key': SHARE_KEY } : {}),
      },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'upload failed');
    return data.node;
  },
};

// デモ用: localStorageに保存(Notion接続なしで試せる)
const demoBackend = (() => {
  const load = () => JSON.parse(localStorage.getItem('mm_demo_data') || '{"files":{},"nodes":{},"seq":0}');
  const save = (d) => localStorage.setItem('mm_demo_data', JSON.stringify(d));
  const uid = (d) => 'demo_' + (++d.seq);
  return {
    name: 'demo',
    status: async () => ({ configured: true, ok: true }),
    listFiles: async () => Object.values(load().files).sort((a, b) => b.edited.localeCompare(a.edited)),
    createFile: async (data) => {
      const d = load(); const id = uid(d);
      const kind = data.kind || 'マップ';
      d.files[id] = { id, name: data.name, kind, parentId: data.parentId || null, layout: 'マップ', theme: 'ノーマル', bg: 'ドット', edited: new Date().toISOString(), nodeCount: kind === 'フォルダ' ? 0 : 1 };
      let root = null;
      if (kind !== 'フォルダ') {
        const rid = uid(d);
        root = { id: rid, name: data.name, fileId: id, parentId: null, order: 0, link: null, collapsed: false, color: null, note: null, x: null, y: null, image: null };
        d.nodes[rid] = root;
      }
      save(d); return { file: d.files[id], root };
    },
    getFile: async (id) => load().files[id],
    updateFile: async (id, data) => { const d = load(); Object.assign(d.files[id], data); save(d); return { file: d.files[id] }; },
    deleteFile: async (id) => {
      const d = load();
      const rec = (fid) => {
        for (const f of Object.values(d.files)) if (f.parentId === fid) rec(f.id);
        delete d.files[fid];
        for (const n of Object.values(d.nodes)) if (n.fileId === fid) delete d.nodes[n.id];
      };
      rec(id);
      save(d);
    },
    listNodes: async (fileId) => Object.values(load().nodes).filter(n => n.fileId === fileId),
    createNode: async (data) => {
      const d = load(); const id = uid(d);
      d.nodes[id] = { id, name: '', link: null, parentId: null, order: 0, collapsed: false, color: null, note: null, x: null, y: null, image: null, ...data };
      save(d); return d.nodes[id];
    },
    updateNode: async (id, data) => {
      const d = load(); Object.assign(d.nodes[id], data);
      if (data.clearImage) d.nodes[id].image = null;
      save(d); return d.nodes[id];
    },
    deleteNode: async (id) => { const d = load(); delete d.nodes[id]; save(d); },
    restoreNode: async (id, snap) => { const d = load(); d.nodes[id] = { ...snap }; save(d); return d.nodes[id]; },
    refreshNode: async (id) => load().nodes[id],
    uploadImage: (id, blob, filename) => new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const d = load(); d.nodes[id].image = { name: filename, url: r.result }; save(d);
        resolve(d.nodes[id]);
      };
      r.readAsDataURL(blob);
    }),
    syncOutline: async () => ({ ok: true }),
  };
})();

// Chrome拡張版: ローカルサーバーなしでNotion APIと直接通信 (host_permissionsでCORS回避)
// 拡張版はサーバーを介さずNotionを直接叩くため、共有リンク機能は使えない
if (IS_EXT) document.body.classList.add('ext');

const extBackend = (() => {
  // DB IDは初回セットアップで自動作成してlocalStorageに保存(未設定は開発者のDBにフォールバック)
  const FILES_DB_DEFAULT = '39ab16a9592380bea63ed1243dfe5020';
  const NODES_DB_DEFAULT = '39ab16a9592380b89026e67a74e88b6c';
  const FILES_DB = () => localStorage.getItem('mm_files_db') || FILES_DB_DEFAULT;
  const NODES_DB = () => localStorage.getItem('mm_nodes_db') || NODES_DB_DEFAULT;
  const V = '2022-06-28';
  const token = () => localStorage.getItem('mm_token');

  async function nf(pathname, method = 'GET', body = null) {
    const res = await fetch('https://api.notion.com/v1' + pathname, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token(),
        'Notion-Version': V,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || res.status); e.code = data.code; e.status = res.status; throw e; }
    return data;
  }
  const plain = (arr) => (arr || []).map(t => t.plain_text).join('');
  const titleProp = (s) => ({ title: [{ text: { content: s || '' } }] });
  const textProp = (s) => ({ rich_text: s ? [{ text: { content: s } }] : [] });

  function parseNode(page) {
    const p = page.properties;
    const img = (p['画像'] && p['画像'].files && p['画像'].files[0]) || null;
    return {
      id: page.id,
      name: plain(p['名前'] && p['名前'].title),
      link: (p['リンク'] && p['リンク'].url) || null,
      parentId: (p['親ノード'] && p['親ノード'].relation[0] && p['親ノード'].relation[0].id) || null,
      fileId: (p['ファイル'] && p['ファイル'].relation[0] && p['ファイル'].relation[0].id) || null,
      order: (p['順序'] && p['順序'].number) ?? 0,
      collapsed: !!(p['折りたたみ'] && p['折りたたみ'].checkbox),
      color: plain(p['色'] && p['色'].rich_text) || null,
      note: plain(p['ノート'] && p['ノート'].rich_text) || null,
      x: (p['位置X'] && p['位置X'].number) ?? null,
      y: (p['位置Y'] && p['位置Y'].number) ?? null,
      topicType: (p['トピック種別'] && p['トピック種別'].select && p['トピック種別'].select.name) || null,
      image: img ? { name: img.name, url: img.file ? img.file.url : (img.external ? img.external.url : null) } : null,
      notionUrl: page.url,
    };
  }
  function nodeProps(d) {
    const props = {};
    if ('name' in d) props['名前'] = titleProp(d.name);
    if ('link' in d) props['リンク'] = { url: d.link || null };
    if ('parentId' in d) props['親ノード'] = { relation: d.parentId ? [{ id: d.parentId }] : [] };
    if ('fileId' in d) props['ファイル'] = { relation: d.fileId ? [{ id: d.fileId }] : [] };
    if ('order' in d) props['順序'] = { number: d.order };
    if ('collapsed' in d) props['折りたたみ'] = { checkbox: !!d.collapsed };
    if ('color' in d) props['色'] = textProp(d.color);
    if ('note' in d) props['ノート'] = textProp(d.note);
    if ('x' in d) props['位置X'] = { number: d.x };
    if ('y' in d) props['位置Y'] = { number: d.y };
    if ('topicType' in d) props['トピック種別'] = { select: d.topicType ? { name: d.topicType } : null };
    if ('clearImage' in d && d.clearImage) props['画像'] = { files: [] };
    return props;
  }
  function parseFile(pg) {
    const p = pg.properties;
    return {
      id: pg.id,
      name: plain(p['ファイル名'] && p['ファイル名'].title),
      kind: (p['種類'] && p['種類'].select && p['種類'].select.name) || 'マップ',
      parentId: (p['親ファイル'] && p['親ファイル'].relation[0] && p['親ファイル'].relation[0].id) || null,
      layout: (p['レイアウト'] && p['レイアウト'].select && p['レイアウト'].select.name) || 'マップ',
      theme: (p['テーマ'] && p['テーマ'].select && p['テーマ'].select.name) || 'ノーマル',
      bg: (p['背景'] && p['背景'].select && p['背景'].select.name) || 'ドット',
      nodeCount: ((p['マインドマップ'] && p['マインドマップ'].relation) || []).length,
      edited: pg.last_edited_time,
      notionUrl: pg.url,
    };
  }
  function fileProps(d) {
    const props = {};
    if ('name' in d) props['ファイル名'] = titleProp(d.name);
    if ('kind' in d) props['種類'] = { select: d.kind ? { name: d.kind } : null };
    if ('parentId' in d) props['親ファイル'] = { relation: d.parentId ? [{ id: d.parentId }] : [] };
    if ('layout' in d) props['レイアウト'] = { select: d.layout ? { name: d.layout } : null };
    if ('theme' in d) props['テーマ'] = { select: d.theme ? { name: d.theme } : null };
    if ('bg' in d) props['背景'] = { select: d.bg ? { name: d.bg } : null };
    return props;
  }
  async function queryAll(dbId, filter) {
    const results = [];
    let cursor;
    do {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (cursor) body.start_cursor = cursor;
      const data = await nf(`/databases/${dbId}/query`, 'POST', body);
      results.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  return {
    name: 'notion-direct',
    status: async () => {
      if (!token()) return { configured: false };
      try { await nf('/databases/' + NODES_DB()); return { configured: true, ok: true }; }
      catch (e) {
        if (e.status === 404) return { configured: true, ok: false, needsDbSetup: true, error: e.code || e.message };
        return { configured: true, ok: false, error: e.code || e.message };
      }
    },
    saveToken: async (t) => {
      // トークン自体の有効性を確認(DBはまだ無くてもよい)
      try {
        const res = await fetch('https://api.notion.com/v1/users/me', {
          headers: { 'Authorization': 'Bearer ' + t, 'Notion-Version': V },
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); return { ok: false, error: d.code || res.status }; }
      } catch (e) { return { ok: false, error: String(e) }; }
      localStorage.setItem('mm_token', t);
      return { ok: true };
    },
    clearToken: async () => { localStorage.removeItem('mm_token'); return { ok: true }; },
    syncOutline: async (fileId) => {
      // マップ構造をNotionページ本文にアウトラインとして書き出す
      const nodes = (await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: fileId } })).map(parseNode);
      const oldBlocks = [];
      let cursor;
      do {
        const data = await nf(`/blocks/${fileId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
        oldBlocks.push(...data.results);
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
      for (const b of oldBlocks) await nf(`/blocks/${b.id}`, 'DELETE');

      const byParent = new Map();
      for (const n of nodes) {
        const k = n.parentId || 'root';
        if (!byParent.has(k)) byParent.set(k, []);
        byParent.get(k).push(n);
      }
      for (const list of byParent.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const roots = byParent.get('root') || [];
      const main = roots.find(r => r.x == null) || roots[0];
      const top = [...(main ? (byParent.get(main.id) || []) : []), ...roots.filter(r => r !== main)];
      const toBlock = (n) => ({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: n.name || '無題', ...(n.link ? { link: { url: n.link } } : {}) } }],
        },
      });
      const appendLevel = async (parentBlockId, list) => {
        if (!list.length) return;
        const created = [];
        for (let i = 0; i < list.length; i += 90) {
          const chunk = list.slice(i, i + 90);
          const res = await nf(`/blocks/${parentBlockId}/children`, 'PATCH', { children: chunk.map(toBlock) });
          created.push(...res.results);
        }
        for (let i = 0; i < list.length; i++) {
          const kids = byParent.get(list[i].id) || [];
          if (kids.length) await appendLevel(created[i].id, kids);
        }
      };
      await appendLevel(fileId, top);
      return { ok: true };
    },
    setupDetect: async () => {
      // 複製されたテンプレート内の2つのDBを名前で探す
      const data = await nf('/search', 'POST', {
        filter: { value: 'database', property: 'object' },
        page_size: 100,
      });
      const byTitle = (t) => data.results
        .filter(db => plain(db.title) === t && !db.archived && !db.in_trash)
        .sort((a, b) => (b.last_edited_time || '').localeCompare(a.last_edited_time || ''))[0];
      const files = byTitle('DB_マインドマップファイル');
      const nodes = byTitle('DB_マインドマップ');
      if (!files || !nodes) return { ok: false, error: 'not_found' };
      localStorage.setItem('mm_files_db', files.id);
      localStorage.setItem('mm_nodes_db', nodes.id);
      return { ok: true, filesDb: files.id, nodesDb: nodes.id };
    },
    listFiles: async () => {
      const files = (await queryAll(FILES_DB())).map(parseFile);
      files.sort((a, b) => b.edited.localeCompare(a.edited));
      return files;
    },
    getFile: async (id) => parseFile(await nf('/pages/' + id)),
    createFile: async (data) => {
      const kind = data.kind || 'マップ';
      const pg = await nf('/pages', 'POST', {
        parent: { database_id: FILES_DB() },
        properties: fileProps({ name: data.name, kind, parentId: data.parentId || null }),
      });
      let root = null;
      if (kind !== 'フォルダ') {
        const rootPg = await nf('/pages', 'POST', {
          parent: { database_id: NODES_DB() },
          properties: nodeProps({ name: data.name, fileId: pg.id, order: 0, topicType: 'タイトルトピック' }),
        });
        root = parseNode(rootPg);
      }
      return { file: parseFile(pg), root };
    },
    updateFile: async (id, data) => ({ file: parseFile(await nf('/pages/' + id, 'PATCH', { properties: fileProps(data) })) }),
    deleteFile: async (id) => {
      const inner = await queryAll(FILES_DB(), { property: '親ファイル', relation: { contains: id } });
      for (const f of inner) await extBackend.deleteFile(f.id);
      const nodes = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: id } });
      for (const n of nodes) await nf(`/pages/${n.id}`, 'PATCH', { archived: true });
      await nf(`/pages/${id}`, 'PATCH', { archived: true });
    },
    listNodes: async (fileId) => (await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: fileId } })).map(parseNode),
    createNode: async (data) => parseNode(await nf('/pages', 'POST', { parent: { database_id: NODES_DB() }, properties: nodeProps(data) })),
    updateNode: async (id, data) => parseNode(await nf(`/pages/${id}`, 'PATCH', { properties: nodeProps(data) })),
    deleteNode: async (id) => { await nf(`/pages/${id}`, 'PATCH', { archived: true }); },
    restoreNode: async (id) => parseNode(await nf(`/pages/${id}`, 'PATCH', { archived: false })),
    refreshNode: async (id) => parseNode(await nf('/pages/' + id)),
    uploadImage: async (id, blob, filename) => {
      const up = await nf('/file_uploads', 'POST', { mode: 'single_part', filename });
      const fd = new FormData();
      fd.append('file', blob, filename);
      const r = await fetch(`https://api.notion.com/v1/file_uploads/${up.id}/send`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token(), 'Notion-Version': V },
        body: fd,
      });
      if (!r.ok) throw new Error('画像のアップロードに失敗しました');
      return parseNode(await nf(`/pages/${id}`, 'PATCH', {
        properties: { '画像': { files: [{ type: 'file_upload', file_upload: { id: up.id }, name: filename }] } },
      }));
    },
  };
})();

const api = IS_EXT ? extBackend : (DEMO ? demoBackend : notionBackend);
// トークン保存やDB検出などの設定操作は、デモ中でも本物のバックエンドに対して行う
const setupApi = IS_EXT ? extBackend : notionBackend;

// ============================================================
// 状態
// ============================================================
const THEMES = {
  'ノーマル': { root: '#3370ff', palette: ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#00a2c7', '#3370ff', '#8e4ec6', '#e93d82'] },
  'アース':   { root: '#6b705c', palette: ['#cb997e', '#a5a58d', '#d4a373', '#81b29a', '#ddbea9', '#e07a5f', '#b7b7a4', '#9d8189'] },
  'オーシャン': { root: '#023e8a', palette: ['#0077b6', '#00b4d8', '#0096c7', '#48cae4', '#5390d9', '#014f86', '#61a5c2', '#2c7da0'] },
  'スペース': { root: '#240046', palette: ['#7b2cbf', '#9d4edd', '#5a189a', '#c77dff', '#4361ee', '#b5179e', '#560bad', '#f72585'] },
};
function theme() { return THEMES[(S.file && S.file.theme) || 'ノーマル'] || THEMES['ノーマル']; }
function isLogic() { return S.file && S.file.layout === 'ロジック図'; }
const GAP_H = 46, GAP_V = 16, GAP_H_ROOT = 64, GAP_V_ROOT = 22;

const S = {
  file: null,            // {id, name}
  nodes: new Map(),      // id -> node
  sel: null,             // 選択中 id
  editing: null,         // 編集中 id
  pan: { x: 0, y: 0 }, zoom: 1,
  queue: [], syncing: false, syncError: false,
  idMap: {},             // tempId -> realId
  tmpSeq: 0,
  geo: new Map(),        // id -> {x, y(=centerY), w, h, side, depth, color}
};

const $ = (s) => document.querySelector(s);
const el = {
  setup: $('#setup-screen'), files: $('#files-screen'), editor: $('#editor-screen'),
  login: $('#login-screen'),
  grid: $('#file-grid'), canvas: $('#canvas'), world: $('#world'),
  edges: $('#edges'), layer: $('#nodes-layer'), title: $('#map-title'),
  insp: $('#inspector'), zoomPct: $('#zoom-pct'), sync: $('#sync-status'), syncText: $('#sync-text'),
  toast: $('#toast'), ghost: $('#drag-ghost'), help: $('#help-pop'),
};

function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('visible'), ms);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  el[name].classList.add('active');
}

// ============================================================
// 同期キュー (ローカル即時反映 → 順次Notionへ保存)
// ============================================================
const rid = (id) => S.idMap[id] || id;
const isTemp = (id) => String(id).startsWith('tmp_');

// ノード編集が落ち着いたら、マップのNotionページ本文にアウトラインを書き出す
const NODE_OPS = new Set(['create', 'update', 'delete', 'image']);
let outlineTimer = null;
function scheduleOutlineSync() {
  if (RO || DEMO || !S.file) return;
  const fid = S.file.id;
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    if (S.queue.length > 0) { scheduleOutlineSync(); return; } // 保存が終わってから
    api.syncOutline(fid).catch(() => {});
  }, 4000);
}

function enqueue(op) {
  if (RO) return; // 閲覧専用では保存しない
  S.queue.push(op);
  if (NODE_OPS.has(op.type)) scheduleOutlineSync();
  processQueue();
}

let queueTimer = null;
async function processQueue() {
  if (S.syncing || S.queue.length === 0) return;
  S.syncing = true;
  setSyncUI('saving');
  while (S.queue.length > 0) {
    const op = S.queue[0];
    try {
      await runOp(op);
      S.queue.shift();
      S.syncError = false;
    } catch (e) {
      console.error('sync error', op, e);
      S.syncError = true;
      setSyncUI('error');
      S.syncing = false;
      clearTimeout(queueTimer);
      queueTimer = setTimeout(processQueue, 4000); // 再試行
      return;
    }
  }
  S.syncing = false;
  setSyncUI('saved');
}

async function runOp(op) {
  if (op.type === 'create') {
    const data = { ...op.data };
    if (data.parentId) data.parentId = rid(data.parentId);
    const real = await api.createNode(data);
    S.idMap[op.tempId] = real.id;
    // ローカルモデルのidを差し替え
    const n = S.nodes.get(op.tempId);
    if (n) {
      S.nodes.delete(op.tempId);
      n.id = real.id; n.notionUrl = real.notionUrl;
      S.nodes.set(real.id, n);
      for (const other of S.nodes.values()) if (other.parentId === op.tempId) other.parentId = real.id;
      if (S.sel === op.tempId) S.sel = real.id;
      if (S.editing === op.tempId) S.editing = real.id;
      const g = S.geo.get(op.tempId);
      if (g) { S.geo.set(real.id, g); S.geo.delete(op.tempId); }
      const dom = el.layer.querySelector(`[data-id="${CSS.escape(op.tempId)}"]`);
      if (dom) dom.dataset.id = real.id;
      // Undo履歴内の参照も差し替え
      for (const en of undoStack) {
        if (en.id === op.tempId) en.id = real.id;
        if (en.ids) en.ids = en.ids.map(x => (x === op.tempId ? real.id : x));
        if (en.prev && en.prev.parentId === op.tempId) en.prev.parentId = real.id;
        if (en.snapshot) {
          for (const s of en.snapshot) {
            if (s.id === op.tempId) s.id = real.id;
            if (s.parentId === op.tempId) s.parentId = real.id;
          }
        }
      }
    }
  } else if (op.type === 'update') {
    const data = { ...op.data };
    if ('parentId' in data && data.parentId) data.parentId = rid(data.parentId);
    await api.updateNode(rid(op.id), data);
  } else if (op.type === 'delete') {
    await api.deleteNode(rid(op.id));
  } else if (op.type === 'restore') {
    const node = await api.restoreNode(rid(op.id), op.snap);
    const n = S.nodes.get(rid(op.id));
    if (n && node && node.image) { n.image = node.image; render(); }
  } else if (op.type === 'deleteFile') {
    await api.deleteFile(op.id);
  } else if (op.type === 'updateFile') {
    await api.updateFile(op.id, op.data);
  } else if (op.type === 'image') {
    const node = await api.uploadImage(rid(op.id), op.blob, op.filename);
    const n = S.nodes.get(rid(op.id));
    if (n && node) { n.image = node.image; render(); }
  }
}

function setSyncUI(state) {
  el.sync.className = state === 'saving' ? 'saving' : state === 'error' ? 'error' : '';
  el.syncText.textContent = state === 'saving' ? '保存中…' : state === 'error' ? 'エラー・再試行中' : '保存済み';
  el.sync.id = 'sync-status';
}

window.addEventListener('beforeunload', (e) => {
  if (S.queue.length > 0) { e.preventDefault(); e.returnValue = ''; }
});

// ============================================================
// モデル操作
// ============================================================
function children(id) {
  return [...S.nodes.values()].filter(n => n.parentId === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function roots() {
  return [...S.nodes.values()].filter(n => !n.parentId);
}
function mainRoot() {
  const rs = roots();
  return rs.find(r => r.x == null) || rs[0] || null;
}
function floatingRoots() {
  const m = mainRoot();
  return roots().filter(r => r !== m);
}
function subtreeIds(id, acc = []) {
  acc.push(id);
  for (const c of children(id)) subtreeIds(c.id, acc);
  return acc;
}
function isDescendant(id, ancestorId) {
  let n = S.nodes.get(id);
  while (n && n.parentId) {
    if (n.parentId === ancestorId) return true;
    n = S.nodes.get(n.parentId);
  }
  return false;
}

// ---------- 元に戻す(⌘Z) ----------
const undoStack = [];
function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > 50) undoStack.shift();
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) { toast('取り消せる操作がありません'); return; }
  if (entry.type === 'update') {
    updateNode(entry.id, entry.prev, { noUndo: true });
    if (S.nodes.has(entry.id)) S.sel = entry.id;
  } else if (entry.type === 'create') {
    for (const id of entry.ids) if (S.nodes.has(id)) deleteNodeRaw(id);
    if (entry.ids.includes(S.sel)) S.sel = (mainRoot() && mainRoot().id) || null;
  } else if (entry.type === 'delete') {
    for (const snap of entry.snapshot) {
      S.nodes.set(snap.id, { ...snap });
      enqueue({ type: 'restore', id: snap.id, snap });
    }
    S.sel = entry.snapshot[0].id;
  }
  render();
  updateInspector();
}

// ---------- トピック種別 (Notion側で判別できるようにselectプロパティへ自動反映) ----------
function computeTopicType(n) {
  if (!n.parentId) return n.x != null ? 'フローティング' : 'タイトルトピック';
  let depth = 0;
  let cur = n;
  while (cur && cur.parentId && depth < 100) {
    depth++;
    cur = S.nodes.get(cur.parentId);
  }
  return depth === 1 ? 'メイントピック' : 'サブトピック';
}

function syncTopicTypes() {
  if (RO || !S.file) return;
  for (const n of S.nodes.values()) {
    const t = computeTopicType(n);
    if (n.topicType !== t) {
      n.topicType = t;
      enqueue({ type: 'update', id: n.id, data: { topicType: t } });
    }
  }
}

function addNode(parentId, opts = {}) {
  const id = 'tmp_' + (++S.tmpSeq) + '_' + Date.now();
  const sibs = children(parentId);
  let order;
  if (opts.afterId) {
    const i = sibs.findIndex(s => s.id === opts.afterId);
    const a = sibs[i], b = sibs[i + 1];
    order = b ? (a.order + b.order) / 2 : (a ? a.order + 1 : 0);
  } else {
    order = sibs.length ? (sibs[sibs.length - 1].order ?? 0) + 1 : 0;
  }
  const node = {
    id, name: opts.name ?? '', parentId, fileId: S.file.id, order,
    link: opts.link ?? null, collapsed: false, color: opts.color ?? null, note: opts.note ?? null,
    x: opts.x ?? null, y: opts.y ?? null, image: null, notionUrl: null,
  };
  S.nodes.set(id, node);
  node.topicType = computeTopicType(node);
  const parent = S.nodes.get(parentId);
  if (parent && parent.collapsed) { parent.collapsed = false; enqueue({ type: 'update', id: parentId, data: { collapsed: false } }); }
  if (!opts.noUndo) pushUndo({ type: 'create', ids: [id] });
  enqueue({ type: 'create', tempId: id, data: { name: node.name, parentId, fileId: S.file.id, order, x: node.x, y: node.y, link: node.link, color: node.color, note: node.note, topicType: node.topicType } });
  return node;
}

const UNDO_KEYS = ['name', 'link', 'parentId', 'order', 'collapsed', 'color', 'note', 'x', 'y'];
function updateNode(id, data, opts = {}) {
  const n = S.nodes.get(id);
  if (!n) return;
  if (!opts.noUndo) {
    const prev = {};
    let changed = false;
    for (const k of UNDO_KEYS) {
      if (k in data && n[k] !== data[k]) { prev[k] = n[k] ?? null; changed = true; }
    }
    if (changed) pushUndo({ type: 'update', id, prev });
  }
  Object.assign(n, data);
  if (data.clearImage) n.image = null;
  enqueue({ type: 'update', id, data });
}

function deleteNodeRaw(id) { // Undo記録なしの削除(undo自身が使う)
  const ids = subtreeIds(id);
  for (const i of ids) S.nodes.delete(i);
  for (const i of ids.reverse()) enqueue({ type: 'delete', id: i });
}

function deleteNode(id) {
  const root = mainRoot();
  if (root && id === root.id) { toast('中心トピックは削除できません'); return; }
  const ids = subtreeIds(id);
  const snapshot = ids.map(i => ({ ...S.nodes.get(i) })); // 親→子の順
  pushUndo({ type: 'delete', snapshot });
  const parentId = S.nodes.get(id).parentId;
  deleteNodeRaw(id);
  S.sel = parentId || (root && root.id) || null;
  render();
  updateInspector();
}

// ---------- トピックのコピー & 貼り付け (⌘C / ⌘V) ----------
let CLIP = null;
function copySelection() {
  if (!S.sel || !S.nodes.has(S.sel)) return;
  const build = (id) => {
    const n = S.nodes.get(id);
    return { name: n.name, link: n.link, color: n.color, note: n.note, children: children(id).map(c => build(c.id)) };
  };
  CLIP = build(S.sel);
  // テキストのアウトラインとしてもコピー(Notionやメモに貼れる)
  const lines = [];
  const walk = (t, d) => { lines.push('\t'.repeat(d) + (t.name || '')); t.children.forEach(c => walk(c, d + 1)); };
  walk(CLIP, 0);
  navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
  toast('トピックをコピーしました');
}

function pasteClip() {
  if (!CLIP || !S.sel || !S.nodes.has(S.sel)) return;
  const created = [];
  const paste = (t, parentId) => {
    const node = addNode(parentId, { name: t.name, link: t.link, color: t.color, note: t.note, noUndo: true });
    created.push(node.id);
    for (const c of t.children) paste(c, node.id);
  };
  paste(CLIP, S.sel);
  pushUndo({ type: 'create', ids: created });
  render();
}

// ============================================================
// レイアウト (中心から左右に展開)
// ============================================================
function effColor(id) {
  // 枝の色: 自分→祖先の順で「色」を探す。なければ第1階層のインデックスでパレット割当
  const PALETTE = theme().palette;
  let n = S.nodes.get(id);
  let last = n;
  while (n) {
    if (n.color) return n.color;
    if (!n.parentId) break;
    last = n;
    n = S.nodes.get(n.parentId);
  }
  if (!n) return PALETTE[0];
  if (n.parentId == null && last !== n) {
    const kids = children(n.id);
    const idx = kids.findIndex(c => c.id === last.id);
    return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
  }
  return n.color || PALETTE[0];
}

function measure() {
  for (const n of S.nodes.values()) {
    const dom = el.layer.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
    if (dom) {
      const g = S.geo.get(n.id) || {};
      g.w = dom.offsetWidth; g.h = dom.offsetHeight;
      S.geo.set(n.id, g);
    }
  }
}

function subtreeH(n, depth) {
  const g = S.geo.get(n.id) || { h: 36 };
  if (n.collapsed) return g.h;
  const kids = children(n.id);
  if (!kids.length) return g.h;
  const gap = depth === 0 ? GAP_V_ROOT : GAP_V;
  const sum = kids.reduce((a, k) => a + subtreeH(k, depth + 1), 0) + gap * (kids.length - 1);
  return Math.max(g.h, sum);
}

function place(n, x, cy, side, depth) {
  const g = S.geo.get(n.id) || { w: 80, h: 36 };
  g.x = side === 'left' ? x - g.w : x; // xは「親に近い側の端」
  g.cy = cy; g.side = side; g.depth = depth;
  g.color = depth === 0 ? (n.color || 'root') : effColor(n.id);
  S.geo.set(n.id, g);
  if (n.collapsed) return;
  const kids = children(n.id);
  if (!kids.length) return;
  const gapH = depth === 0 ? GAP_H_ROOT : GAP_H;
  const gapV = depth === 0 ? GAP_V_ROOT : GAP_V;
  const total = kids.reduce((a, k) => a + subtreeH(k, depth + 1), 0) + gapV * (kids.length - 1);
  let y = cy - total / 2;
  for (const k of kids) {
    const h = subtreeH(k, depth + 1);
    const childX = side === 'left' ? g.x - gapH : g.x + g.w + gapH;
    place(k, childX, y + h / 2, side, depth + 1);
    y += h + gapV;
  }
}

function layout() {
  const root = mainRoot();
  if (!root) return;
  measure();
  const g = S.geo.get(root.id) || { w: 120, h: 50 };
  // マップ: 子を左右に振り分け / ロジック図: すべて右側
  const kids = children(root.id);
  const nRight = isLogic() ? kids.length : Math.ceil(kids.length / 2);
  const rightKids = kids.slice(0, nRight);
  const leftKids = kids.slice(nRight);

  g.x = -g.w / 2; g.cy = 0; g.side = 'right'; g.depth = 0; g.color = root.color || 'root';
  S.geo.set(root.id, g);

  if (!root.collapsed) {
    const placeSide = (list, side) => {
      const total = list.reduce((a, k) => a + subtreeH(k, 1), 0) + GAP_V_ROOT * Math.max(0, list.length - 1);
      let y = -total / 2;
      for (const k of list) {
        const h = subtreeH(k, 1);
        const x = side === 'right' ? g.x + g.w + GAP_H_ROOT : g.x - GAP_H_ROOT;
        place(k, x, y + h / 2, side, 1);
        y += h + GAP_V_ROOT;
      }
    };
    placeSide(rightKids, 'right');
    placeSide(leftKids, 'left');
  }

  // フローティングトピック
  for (const f of floatingRoots()) {
    place(f, f.x ?? 200, f.y ?? 200, 'right', 1);
  }
}

// ============================================================
// 描画
// ============================================================
// 白はテーマに関係なく常に選べるようにする
const WHITE = '#ffffff';
function isNearWhite(hex) {
  if (!hex || hex[0] !== '#') return false;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return r > 235 && g > 235 && b > 235;
}

// 画像の読み込み後に一度だけ再レイアウトするための記録
const imgSized = new Set();
let imgRelayoutTimer = null;

function textColorFor(hex) {
  if (!hex || hex[0] !== '#') return '#fff';
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1d1d1f' : '#fff';
}

function visibleIds() {
  const out = [];
  const walk = (n) => {
    out.push(n.id);
    if (!n.collapsed) for (const c of children(n.id)) walk(c);
  };
  const m = mainRoot();
  if (m) walk(m);
  for (const f of floatingRoots()) walk(f);
  return out;
}

function nodeDepth(id) {
  let d = 0, n = S.nodes.get(id);
  while (n && n.parentId) { d++; n = S.nodes.get(n.parentId); }
  return d;
}

function buildNodeDom(n) {
  let dom = el.layer.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
  if (!dom) {
    dom = document.createElement('div');
    dom.className = 'node';
    dom.dataset.id = n.id;
    el.layer.appendChild(dom);
  }
  const depth = nodeDepth(n.id);
  dom.className = 'node depth-' + Math.min(depth, 2)
    + (S.sel === n.id ? ' selected' : '')
    + (S.editing === n.id ? ' editing' : '');

  // 中身を再構築(編集中はスキップして入力を守る)
  if (S.editing !== n.id || !dom.querySelector('.node-text[contenteditable]')) {
    dom.innerHTML = '';
    if (n.image && n.image.url) {
      const img = document.createElement('img');
      img.className = 'node-img';
      img.src = n.image.url;
      img.draggable = false;
      // 画像が読み込まれると高さが変わるので、一度だけ再レイアウトする
      const sizeKey = n.id + '|' + n.image.url;
      img.onload = () => {
        if (imgSized.has(sizeKey)) return;
        imgSized.add(sizeKey);
        clearTimeout(imgRelayoutTimer);
        imgRelayoutTimer = setTimeout(function relayout() {
          // 編集中・ドラッグ中は再描画で操作を邪魔しないよう後回しにする
          if (S.editing || drag) { imgRelayoutTimer = setTimeout(relayout, 200); return; }
          render();
        }, 60);
      };
      img.onerror = async () => {
        if (img.dataset.retried || isTemp(n.id) || api.name === 'demo') return;
        img.dataset.retried = '1';
        try {
          const fresh = await api.refreshNode(rid(n.id));
          if (fresh && fresh.image) { n.image = fresh.image; img.src = fresh.image.url; }
        } catch {}
      };
      dom.appendChild(img);
    }
    const row = document.createElement('div');
    row.className = 'node-row';
    const txt = document.createElement('div');
    txt.className = 'node-text';
    txt.textContent = n.name || ' ';
    row.appendChild(txt);
    if (n.link) {
      const a = document.createElement('a');
      a.className = 'node-link'; a.href = n.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = n.link + '\n(クリックで開く)';
      a.innerHTML = ICON.link;
      a.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(a);
    }
    if (n.note) {
      const ind = document.createElement('span');
      ind.className = 'node-note-ind'; ind.innerHTML = ICON.note; ind.title = n.note;
      row.appendChild(ind);
    }
    dom.appendChild(row);
  }

  // 色
  const depthCls = Math.min(depth, 2);
  if (depthCls === 0) {
    const c = n.color || theme().root;
    dom.style.background = c; dom.style.color = textColorFor(c);
  } else if (depthCls === 1) {
    const c = effColor(n.id);
    dom.style.background = c; dom.style.color = textColorFor(c);
  } else if (n.color) {
    dom.style.background = n.color; dom.style.color = textColorFor(n.color);
  } else {
    dom.style.background = '#fff'; dom.style.color = 'var(--text)';
  }
  // 白は背景に溶けるので、うっすら枠線を出す(選択中の枠を邪魔しないようCSS側で制御)
  dom.classList.toggle('white-bg', isNearWhite(dom.style.backgroundColor) || isNearWhite(n.color));
  return dom;
}

function render() {
  syncTopicTypes(); // 構造が変わったら種別(タイトル/メイン/サブ/フローティング)をNotionに反映
  const vis = new Set(visibleIds());

  // 不要なDOM削除
  for (const dom of [...el.layer.children]) {
    if (dom.classList.contains('collapse-btn')) { dom.remove(); continue; }
    if (!vis.has(dom.dataset.id)) dom.remove();
  }
  // ノードDOM構築
  for (const id of vis) buildNodeDom(S.nodes.get(id));

  // レイアウト計算
  layout();

  // 位置適用
  for (const id of vis) {
    const g = S.geo.get(id);
    const dom = el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (g && dom) {
      dom.style.left = g.x + 'px';
      dom.style.top = (g.cy - g.h / 2) + 'px';
    }
  }

  // 折りたたみボタン
  for (const id of vis) {
    const n = S.nodes.get(id);
    const kids = children(id);
    if (!kids.length || !n.parentId) continue; // ルートは対象外
    const g = S.geo.get(id);
    if (!g) continue;
    const btn = document.createElement('button');
    btn.className = 'collapse-btn' + (n.collapsed ? ' has-count' : '');
    btn.textContent = n.collapsed ? String(kids.length) : '−';
    const bx = g.side === 'left' ? g.x - 20 : g.x + g.w + 2;
    btn.style.left = bx + 'px';
    btn.style.top = (g.cy - 9) + 'px';
    btn.style.position = 'absolute';
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      updateNode(id, { collapsed: !n.collapsed });
      render();
    });
    el.layer.appendChild(btn);
  }

  drawEdges(vis);
  applyTransform();
}

function drawEdges(vis) {
  const paths = [];
  for (const id of vis) {
    const n = S.nodes.get(id);
    if (!n.parentId || !vis.has(n.parentId)) continue;
    const g = S.geo.get(id), pg = S.geo.get(n.parentId);
    if (!g || !pg) continue;
    let sx, ex;
    if (g.side === 'left') { sx = pg.x; ex = g.x + g.w; }
    else { sx = pg.x + pg.w; ex = g.x; }
    const sy = pg.cy, ey = g.cy;
    const color = effColor(id);
    const width = g.depth === 1 ? 3 : 2;
    let d;
    if (isLogic()) {
      // ロジック図: 直角(角丸)コネクタ
      const mx = (sx + ex) / 2;
      const r = Math.min(8, Math.abs(ey - sy) / 2, Math.abs(ex - mx));
      if (Math.abs(ey - sy) < 1) {
        d = `M ${sx} ${sy} L ${ex} ${ey}`;
      } else {
        const dir = ey > sy ? 1 : -1;
        d = `M ${sx} ${sy} L ${mx - r} ${sy} Q ${mx} ${sy} ${mx} ${sy + r * dir} L ${mx} ${ey - r * dir} Q ${mx} ${ey} ${mx + r} ${ey} L ${ex} ${ey}`;
      }
    } else {
      const dx = (ex - sx) * 0.55;
      d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
    }
    const stroke = (isNearWhite(color) && (S.file && S.file.bg) !== 'ブラック') ? '#d5d5dc' : color;
    paths.push(`<path d="${d}" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linecap="round"/>`);
  }
  el.edges.innerHTML = paths.join('');
}

function applyTransform() {
  el.world.style.transform = `translate(${S.pan.x}px, ${S.pan.y}px) scale(${S.zoom})`;
  el.zoomPct.textContent = Math.round(S.zoom * 100) + '%';
}

// ============================================================
// ビュー操作 (パン・ズーム)
// ============================================================
function canvasRect() { return el.canvas.getBoundingClientRect(); }
function toWorld(clientX, clientY) {
  const r = canvasRect();
  return { x: (clientX - r.left - S.pan.x) / S.zoom, y: (clientY - r.top - S.pan.y) / S.zoom };
}

function setZoom(z, cx, cy) {
  z = Math.min(4, Math.max(0.2, z));
  const r = canvasRect();
  cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
  const wx = (cx - S.pan.x) / S.zoom, wy = (cy - S.pan.y) / S.zoom;
  S.zoom = z;
  S.pan.x = cx - wx * z;
  S.pan.y = cy - wy * z;
  applyTransform();
}

function fitView() {
  const gs = [...S.geo.entries()].filter(([id]) => S.nodes.has(id) && el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`));
  if (!gs.length) return;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [, g] of gs) {
    minX = Math.min(minX, g.x); maxX = Math.max(maxX, g.x + g.w);
    minY = Math.min(minY, g.cy - g.h / 2); maxY = Math.max(maxY, g.cy + g.h / 2);
  }
  const r = canvasRect();
  const pad = 60;
  const z = Math.min(2, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)));
  S.zoom = Math.max(0.2, Math.min(1.2, z));
  S.pan.x = r.width / 2 - (minX + maxX) / 2 * S.zoom;
  S.pan.y = r.height / 2 - (minY + maxY) / 2 * S.zoom;
  applyTransform();
}

el.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvasRect();
  if (e.ctrlKey || e.metaKey) {
    setZoom(S.zoom * (e.deltaY < 0 ? 1.08 : 0.93), e.clientX - r.left, e.clientY - r.top);
  } else {
    S.pan.x -= e.deltaX;
    S.pan.y -= e.deltaY;
    applyTransform();
  }
}, { passive: false });

$('#zoom-in').addEventListener('click', () => setZoom(S.zoom * 1.2));
$('#zoom-out').addEventListener('click', () => setZoom(S.zoom / 1.2));
$('#zoom-fit').addEventListener('click', fitView);

// ============================================================
// ポインタ操作 (選択・ドラッグ・パン)
// ============================================================
let drag = null; // {id, startX, startY, moved, target, zone} | {pan:true,...}

el.canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // リンクアイコンはブラウザの既定動作(リンクを開く)に任せる
  if (e.target.closest('.node-link')) return;
  const nodeDom = e.target.closest('.node');
  if (nodeDom) {
    const id = nodeDom.dataset.id;
    if (S.editing === id) return; // 編集中はテキスト操作
    if (S.editing) commitEdit();
    const wasSelected = S.sel === id; // 選択済みへの2回目クリック=編集開始
    selectNode(id);
    const root = mainRoot();
    const draggable = !RO && root && id !== root.id;
    drag = { id, startX: e.clientX, startY: e.clientY, moved: false, draggable, wasSelected, img: !!e.target.closest('.node-img') };
    try { el.canvas.setPointerCapture(e.pointerId); } catch {}
  } else {
    if (S.editing) commitEdit();
    selectNode(null);
    drag = { pan: true, startX: e.clientX, startY: e.clientY, panX: S.pan.x, panY: S.pan.y };
    el.canvas.classList.add('panning');
    try { el.canvas.setPointerCapture(e.pointerId); } catch {}
  }
});

el.canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.pan) {
    S.pan.x = drag.panX + (e.clientX - drag.startX);
    S.pan.y = drag.panY + (e.clientY - drag.startY);
    applyTransform();
    return;
  }
  const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.moved && dist > 6 && drag.draggable) {
    drag.moved = true;
    const n = S.nodes.get(drag.id);
    el.ghost.textContent = n.name || '(無題)';
    el.ghost.style.display = 'block';
    el.layer.querySelector(`[data-id="${CSS.escape(drag.id)}"]`)?.classList.add('drag-source');
  }
  if (!drag.moved) return;
  el.ghost.style.left = (e.clientX + 12) + 'px';
  el.ghost.style.top = (e.clientY + 12) + 'px';
  // ドロップターゲット判定
  clearDropHints();
  const t = findDropTarget(e.clientX, e.clientY);
  drag.target = t;
  if (t) {
    const dom = el.layer.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
    dom?.classList.add(t.zone === 'child' ? 'drop-child' : t.zone === 'before' ? 'drop-before' : 'drop-after');
  }
});

// タッチ操作でドラッグ中は、ブラウザ側のスクロール等を起こさせない
el.canvas.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

// 途中でブラウザに操作を取られた場合は、表示を元に戻すだけにする
el.canvas.addEventListener('pointercancel', () => {
  if (!drag) return;
  el.canvas.classList.remove('panning');
  clearDropHints();
  el.ghost.style.display = 'none';
  el.layer.querySelector(`[data-id="${CSS.escape(drag.id || '')}"]`)?.classList.remove('drag-source');
  drag = null;
});

el.canvas.addEventListener('pointerup', (e) => {
  if (!drag) return;
  el.canvas.classList.remove('panning');
  clearDropHints();
  el.ghost.style.display = 'none';
  el.layer.querySelector(`[data-id="${CSS.escape(drag.id || '')}"]`)?.classList.remove('drag-source');

  if (!drag.pan && drag.moved) {
    const t = drag.target;
    const id = drag.id;
    if (t) {
      applyDrop(id, t);
    } else {
      // 空きスペース → フローティングトピック
      const w = toWorld(e.clientX, e.clientY);
      updateNode(id, { parentId: null, x: Math.round(w.x), y: Math.round(w.y) });
      render();
    }
  } else if (!drag.pan && !drag.moved) {
    if (drag.img) {
      // 画像をクリック → 拡大表示
      openLightbox(drag.id);
    } else if (drag.wasSelected && !RO) {
      // 選択済みトピックへのクリック → クリック位置にキャレットを置いて編集開始
      startEditAt(drag.id, e.clientX, e.clientY);
    }
  }
  drag = null;
});

el.canvas.addEventListener('dblclick', (e) => {
  if (RO || S.editing) return;
  if (e.target.closest('.node-link')) return; // リンクを開く操作を邪魔しない
  if (e.target.closest('.node-img')) return; // 画像は拡大表示が優先
  const nodeDom = e.target.closest('.node');
  if (nodeDom) startEdit(nodeDom.dataset.id);
});

// クリックした文字位置にキャレットを置いて編集を開始
function startEditAt(id, clientX, clientY) {
  startEdit(id);
  const dom = el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const txt = dom?.querySelector('.node-text');
  if (!txt) return;
  try {
    const r = document.caretRangeFromPoint(clientX, clientY);
    if (r && txt.contains(r.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } catch {}
}

// ---------- 画像の拡大表示 ----------
let lbNodeId = null;

function openLightbox(id) {
  const n = S.nodes.get(id);
  if (!n || !n.image || !n.image.url) return;
  lbNodeId = id;
  $('#lb-img').src = n.image.url;
  $('#lightbox').style.display = 'flex';
}

function closeLightbox() {
  $('#lightbox').style.display = 'none';
  $('#lb-img').src = '';
  lbNodeId = null;
}

$('#lightbox').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'lightbox') closeLightbox(); // 背景クリックで閉じる
});
$('#lb-close').addEventListener('click', closeLightbox);

$('#lb-download').addEventListener('click', async () => {
  const n = S.nodes.get(lbNodeId);
  if (!n || !n.image) return;
  try {
    const r = await fetch(n.image.url);
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = n.image.name || 'image.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    window.open(n.image.url, '_blank'); // 直接取得できない場合は新しいタブで
  }
});

$('#lb-replace').addEventListener('click', () => {
  if (RO || !lbNodeId) return;
  S.sel = lbNodeId;
  closeLightbox();
  $('#img-file').click(); // 既存の選択ハンドラがS.selに添付する
});

$('#lb-delete').addEventListener('click', () => {
  if (RO || !lbNodeId) return;
  updateNode(lbNodeId, { clearImage: true });
  closeLightbox();
  render();
});

function clearDropHints() {
  el.layer.querySelectorAll('.drop-child, .drop-before, .drop-after').forEach(d =>
    d.classList.remove('drop-child', 'drop-before', 'drop-after'));
}

function findDropTarget(clientX, clientY) {
  const excluded = new Set(subtreeIds(drag.id));
  const margin = 14 * S.zoom;
  // 記録済みの座標ではなく実際の描画位置で判定する
  // (画像入りトピックは読み込みで高さが変わるため、記録値だと別の場所に入ってしまう)
  let best = null;
  for (const id of S.geo.keys()) {
    if (excluded.has(id) || !S.nodes.has(id)) continue;
    const dom = el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!dom) continue;
    const r = dom.getBoundingClientRect();
    if (!r.height) continue;
    const inside = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    const near = clientX >= r.left - margin && clientX <= r.right + margin
              && clientY >= r.top - margin && clientY <= r.bottom + margin;
    if (!near) continue;
    // 重なっている場合は、実際に触れているもの・小さいものを優先する
    const score = (inside ? 0 : 1) * 1e9 + r.width * r.height;
    if (!best || score < best.score) best = { id, rect: r, score };
  }
  if (!best) return null;

  const n = S.nodes.get(best.id);
  const canSibling = n.parentId != null;
  // 上下の判定帯は、背の高いトピック(画像入り)でも端の一定幅に収める
  const band = Math.min(best.rect.height * 0.25, 26 * S.zoom);
  if (canSibling && clientY < best.rect.top + band) return { id: best.id, zone: 'before' };
  if (canSibling && clientY > best.rect.bottom - band) return { id: best.id, zone: 'after' };
  return { id: best.id, zone: 'child' };
}

function applyDrop(id, t) {
  const n = S.nodes.get(id);
  if (t.zone === 'child') {
    const kids = children(t.id).filter(k => k.id !== id);
    const order = kids.length ? (kids[kids.length - 1].order ?? 0) + 1 : 0;
    updateNode(id, { parentId: t.id, order, x: null, y: null });
    const tn = S.nodes.get(t.id);
    if (tn.collapsed) updateNode(t.id, { collapsed: false });
  } else {
    const target = S.nodes.get(t.id);
    const sibs = children(target.parentId).filter(k => k.id !== id);
    const i = sibs.findIndex(s => s.id === t.id);
    let order;
    if (t.zone === 'before') {
      const prev = sibs[i - 1];
      order = prev ? (prev.order + target.order) / 2 : target.order - 1;
    } else {
      const next = sibs[i + 1];
      order = next ? (target.order + next.order) / 2 : target.order + 1;
    }
    updateNode(id, { parentId: target.parentId, order, x: null, y: null });
  }
  render();
}

// ============================================================
// 選択・編集
// ============================================================
function selectNode(id) {
  S.sel = id;
  S.inspTab = id ? 'node' : 'design';
  render();
  updateInspector();
}

function startEdit(id, appendChar) {
  if (!id) return;
  if (S.editing === id) return; // すでに編集中ならキャレットを動かさない
  S.editing = id;
  render();
  const dom = el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const txt = dom?.querySelector('.node-text');
  if (!txt) return;
  txt.contentEditable = 'plaintext-only';
  const n = S.nodes.get(id);
  // 文字キーで編集を始めた場合は全置換ではなく末尾に追記
  txt.textContent = appendChar != null ? (n.name || '') + appendChar : (n.name || '');
  txt.focus();
  // キャレットを末尾に置く(全選択すると誤って全文を消しやすいため)
  const range = document.createRange();
  range.selectNodeContents(txt);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(range);

  txt.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中のキーは無視
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); addChildOfSelection(); }
  });
  txt.addEventListener('blur', () => { if (S.editing === id) commitEdit(); });
  txt.addEventListener('input', () => render()); // サイズ変化に追従
}

function commitEdit() {
  const id = S.editing;
  if (!id) return;
  const dom = el.layer.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const txt = dom?.querySelector('.node-text');
  S.editing = null;
  if (txt) {
    const name = txt.textContent.replace(/ /g, ' ').trimEnd();
    txt.contentEditable = 'false';
    const n = S.nodes.get(id);
    if (n && name !== n.name) updateNode(id, { name });
  }
  render();
}

function cancelEdit() {
  S.editing = null;
  render();
}

function addChildOfSelection() {
  if (!S.sel) return;
  const node = addNode(S.sel);
  render();
  selectNode(node.id);
  startEdit(node.id);
}

function addSiblingOfSelection() {
  if (!S.sel) return;
  const sel = S.nodes.get(S.sel);
  const root = mainRoot();
  if (!sel.parentId) { addChildOfSelection(); return; } // ルートでEnter→子追加
  const node = addNode(sel.parentId, { afterId: S.sel });
  render();
  selectNode(node.id);
  startEdit(node.id);
}

// キーボード
document.addEventListener('keydown', (e) => {
  // 画像の拡大表示中はEscだけ処理
  if ($('#lightbox').style.display !== 'none') {
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    return;
  }
  if (!el.editor.classList.contains('active')) return;
  if (S.editing) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && (e.key === 'z' || e.key === 'Z')) { if (!RO) { e.preventDefault(); undo(); } }
  else if (mod && e.key === 'c') { if (S.sel) { e.preventDefault(); copySelection(); } }
  else if (RO) { return; }
  else if (e.key === 'Tab') { e.preventDefault(); addChildOfSelection(); }
  else if (e.key === 'Enter') { e.preventDefault(); addSiblingOfSelection(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (S.sel) deleteNode(S.sel); }
  else if (e.key === ' ' || e.key === 'F2') { e.preventDefault(); startEdit(S.sel); }
  else if (e.key.startsWith('Arrow')) { e.preventDefault(); navigate(e.key); }
  else if (e.key.length === 1 && !mod && !e.altKey && !e.isComposing && e.keyCode !== 229 && S.sel) {
    e.preventDefault(); startEdit(S.sel, e.key);
  }
});

function navigate(key) {
  if (!S.sel) { const r = mainRoot(); if (r) selectNode(r.id); return; }
  const n = S.nodes.get(S.sel);
  const g = S.geo.get(S.sel);
  if (!n || !g) return;
  const sibs = n.parentId ? children(n.parentId) : [];
  const idx = sibs.findIndex(s => s.id === n.id);
  const kids = n.collapsed ? [] : children(n.id);

  let next = null;
  if (key === 'ArrowUp') next = sibs[idx - 1];
  else if (key === 'ArrowDown') next = sibs[idx + 1];
  else if (key === 'ArrowRight') {
    if (g.side === 'right' || g.depth === 0) next = kids.find(k => (S.geo.get(k.id) || {}).side !== 'left');
    else next = S.nodes.get(n.parentId);
  } else if (key === 'ArrowLeft') {
    if (g.side === 'left' || g.depth === 0) next = kids.find(k => (S.geo.get(k.id) || {}).side === 'left') || (g.depth === 0 ? null : kids[0]);
    else next = S.nodes.get(n.parentId);
  }
  if (next) selectNode(next.id);
}

// ツールバー
$('#btn-add-child').addEventListener('click', addChildOfSelection);
$('#btn-add-sibling').addEventListener('click', addSiblingOfSelection);
$('#btn-delete').addEventListener('click', () => S.sel && deleteNode(S.sel));
$('#btn-help').addEventListener('click', () => el.help.classList.toggle('visible'));
$('#btn-back').addEventListener('click', () => { openFilesScreen(); });

let titleTimer = null;
el.title.addEventListener('input', () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    if (!S.file) return;
    S.file.name = el.title.value;
    const f = filesAll.find(x => x.id === S.file.id);
    if (f) f.name = el.title.value;
    enqueue({ type: 'updateFile', id: S.file.id, data: { name: el.title.value } });
  }, 600);
});

// マップ設定 (レイアウト・テーマ・背景)
function applyBg() {
  el.canvas.className = S.file && S.file.bg === 'ホワイト' ? 'bg-white' : S.file && S.file.bg === 'ブラック' ? 'bg-black' : '';
}
function saveFileSetting(key, value) {
  if (!S.file) return;
  S.file[key] = value;
  const f = filesAll.find(x => x.id === S.file.id);
  if (f) f[key] = value;
  enqueue({ type: 'updateFile', id: S.file.id, data: { [key]: value } });
}
// パネル「デザイン」タブの中身
function renderDesignPanel() {
  if (!S.file) return;
  const seg = (sel, options, cur, onPick) => {
    const wrap = $(sel);
    wrap.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.className = o.value === cur ? 'active' : '';
      b.addEventListener('click', () => onPick(o.value));
      wrap.appendChild(b);
    }
  };
  seg('#seg-layout',
    [{ label: 'マップ', value: 'マップ' }, { label: 'ロジック図', value: 'ロジック図' }],
    S.file.layout,
    (v) => { saveFileSetting('layout', v); render(); fitView(); renderDesignPanel(); });
  seg('#seg-bg',
    [{ label: 'ドット', value: 'ドット' }, { label: '白', value: 'ホワイト' }, { label: '黒', value: 'ブラック' }],
    S.file.bg,
    (v) => { saveFileSetting('bg', v); applyBg(); renderDesignPanel(); });
  const grid = $('#theme-grid');
  grid.innerHTML = '';
  for (const [name, t] of Object.entries(THEMES)) {
    const card = document.createElement('button');
    card.className = 'theme-card' + (S.file.theme === name ? ' active' : '');
    card.innerHTML = `<div class="tname">${name}</div><div class="dots">${[t.root, ...t.palette.slice(0, 4)].map(c => `<span style="background:${c}"></span>`).join('')}</div>`;
    card.addEventListener('click', () => {
      saveFileSetting('theme', name);
      // 個別に設定した色も含めて、すべてテーマの色に切り替える
      for (const n of S.nodes.values()) {
        if (n.color) updateNode(n.id, { color: null });
      }
      render();
      renderDesignPanel();
    });
    grid.appendChild(card);
  }
}

// 名前入力ダイアログ (日本語変換の確定Enterでは送信されない)
function askName(title, def = '') {
  return new Promise((resolve) => {
    const ov = $('#name-dialog');
    const input = $('#nd-input');
    $('#nd-title').textContent = title;
    input.value = def;
    ov.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const close = (val) => {
      ov.style.display = 'none';
      input.removeEventListener('keydown', onKey);
      $('#nd-ok').removeEventListener('click', ok);
      $('#nd-cancel').removeEventListener('click', cancel);
      ov.removeEventListener('pointerdown', onOverlay);
      resolve(val);
    };
    const ok = () => close(input.value.trim());
    const cancel = () => close(null);
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return; // 変換確定のEnterは無視
        e.preventDefault();
        ok();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    const onOverlay = (e) => { if (e.target === ov) cancel(); };
    input.addEventListener('keydown', onKey);
    $('#nd-ok').addEventListener('click', ok);
    $('#nd-cancel').addEventListener('click', cancel);
    ov.addEventListener('pointerdown', onOverlay);
  });
}

// 設定パネルの表示/非表示とタブ
S.inspOpen = localStorage.getItem('mm_insp') === '1';
S.inspTab = 'design';
$('#btn-panel').addEventListener('click', () => {
  S.inspOpen = !S.inspOpen;
  localStorage.setItem('mm_insp', S.inspOpen ? '1' : '0');
  $('#btn-panel').classList.toggle('active', S.inspOpen);
  updateInspector();
});
$('#tab-design').addEventListener('click', () => { S.inspTab = 'design'; updateInspector(); });
$('#tab-node').addEventListener('click', () => {
  if (!S.sel || !S.nodes.has(S.sel)) {
    toast('トピックが未選択です。マップ上のトピックをクリックしてください');
    return;
  }
  S.inspTab = 'node';
  updateInspector();
});

// ============================================================
// インスペクタ
// ============================================================
function updateInspector() {
  if (RO || !S.inspOpen || !el.editor.classList.contains('active')) { el.insp.classList.remove('visible'); return; }
  el.insp.classList.add('visible');
  const hasSel = S.sel && S.nodes.has(S.sel);
  if (!hasSel) S.inspTab = 'design';
  $('#tab-design').classList.toggle('active', S.inspTab === 'design');
  $('#tab-node').classList.toggle('active', S.inspTab === 'node');
  $('#tab-node').classList.toggle('disabled', !hasSel); // 見た目は無効・クリックで注意を表示
  $('#insp-design').style.display = S.inspTab === 'design' ? '' : 'none';
  $('#insp-node').style.display = S.inspTab === 'node' ? '' : 'none';
  if (S.inspTab === 'design') { renderDesignPanel(); return; }
  const n = S.nodes.get(S.sel);
  $('#insp-link').value = n.link || '';
  $('#insp-note').value = n.note || '';
  const link = $('#insp-notion-link');
  if (n.notionUrl && api.name !== 'demo') { link.style.display = ''; link.href = n.notionUrl; }
  else link.style.display = 'none';
  // 色スウォッチ
  const row = $('#color-row');
  row.innerHTML = '';
  const noneBtn = document.createElement('button');
  noneBtn.className = 'color-sw none' + (!n.color ? ' selected' : '');
  noneBtn.title = '自動';
  noneBtn.addEventListener('click', () => { updateNode(S.sel, { color: null }); render(); updateInspector(); });
  row.appendChild(noneBtn);
  for (const c of [...theme().palette, WHITE]) {
    const b = document.createElement('button');
    b.className = 'color-sw' + (c === WHITE ? ' white' : '') + (n.color === c ? ' selected' : '');
    b.style.background = c;
    if (c === WHITE) b.title = '白';
    b.addEventListener('click', () => { updateNode(S.sel, { color: c }); render(); updateInspector(); });
    row.appendChild(b);
  }
}

let linkTimer = null;
$('#insp-link').addEventListener('input', (e) => {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    if (!S.sel) return;
    updateNode(S.sel, { link: e.target.value.trim() || null });
    render();
  }, 600);
});

let noteTimer = null;
$('#insp-note').addEventListener('input', (e) => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (!S.sel) return;
    updateNode(S.sel, { note: e.target.value || null });
    render();
  }, 600);
});

$('#insp-img-add').addEventListener('click', () => $('#img-file').click());
$('#img-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f && S.sel) attachImage(S.sel, f);
  e.target.value = '';
});
$('#insp-img-del').addEventListener('click', () => {
  if (!S.sel) return;
  updateNode(S.sel, { clearImage: true });
  render();
});

function attachImage(id, file) {
  if (file.size > 19 * 1024 * 1024) { toast('画像は20MB以下にしてください'); return; }
  const n = S.nodes.get(id);
  // ローカルで即プレビュー
  const localUrl = URL.createObjectURL(file);
  n.image = { name: file.name, url: localUrl };
  render();
  enqueue({ type: 'image', id, blob: file, filename: file.name || 'image.png' });
  toast('画像をアップロード中…');
}

// 画像ペースト
document.addEventListener('paste', (e) => {
  if (RO || !el.editor.classList.contains('active') || S.editing) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!S.sel) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const f = item.getAsFile();
      const ext = item.type.split('/')[1] || 'png';
      attachImage(S.sel, new File([f], `pasted_${Date.now()}.${ext}`, { type: item.type }));
      return;
    }
  }
  // 画像がなければ、⌘Cでコピーしたトピックを子として貼り付け
  if (CLIP) {
    e.preventDefault();
    pasteClip();
  }
});

// ドラッグ&ドロップで画像ファイル
el.canvas.addEventListener('dragover', (e) => e.preventDefault());
el.canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  if (RO) return;
  const f = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/'));
  if (!f) return;
  const nodeDom = e.target.closest('.node');
  const id = nodeDom ? nodeDom.dataset.id : S.sel;
  if (id) attachImage(id, f);
});

// ============================================================
// 画面遷移
// ============================================================
let filesAll = [];
let curFolder = null;   // 現在開いているフォルダのid (null=トップ)
let suppressOpen = false;

async function openFilesScreen(refresh = true) {
  showScreen('files');
  if (refresh) {
    el.grid.innerHTML = '<div class="spinner"></div>';
    try {
      filesAll = await api.listFiles();
    } catch (e) {
      el.grid.innerHTML = `<p style="color:#e5484d">読み込みエラー: ${e.message}</p>`;
      return;
    }
  }
  if (curFolder && !filesAll.find(f => f.id === curFolder)) curFolder = null;
  renderFiles();
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  bc.innerHTML = '';
  const chain = [];
  let f = filesAll.find(x => x.id === curFolder);
  while (f) { chain.unshift(f); f = filesAll.find(x => x.id === f.parentId); }
  const mk = (label, id, current) => {
    const b = document.createElement('button');
    b.className = 'crumb' + (current ? ' current' : '');
    b.textContent = label;
    b.dataset.folderTarget = id ?? '';
    if (!current) b.addEventListener('click', () => { curFolder = id; renderFiles(); });
    return b;
  };
  bc.appendChild(mk('NeuMind', null, chain.length === 0));
  for (let i = 0; i < chain.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep'; sep.textContent = '›';
    bc.appendChild(sep);
    bc.appendChild(mk(chain[i].name || '無題', chain[i].id, i === chain.length - 1));
  }
}

function renderFiles() {
  renderBreadcrumb();
  el.grid.innerHTML = '';
  const items = filesAll.filter(f => (f.parentId || null) === curFolder);
  const folders = items.filter(f => f.kind === 'フォルダ');
  const maps = items.filter(f => f.kind !== 'フォルダ');

  const newCard = document.createElement('div');
  newCard.className = 'file-card new';
  newCard.innerHTML = '<div class="plus">＋</div><div>新規作成</div>';
  newCard.addEventListener('click', (e) => showCreateMenu(e.clientX, e.clientY));
  el.grid.appendChild(newCard);

  for (const f of [...folders, ...maps]) el.grid.appendChild(buildFileCard(f));

  renderRecents();

  const footer = $('#files-footer');
  footer.innerHTML = '';
  if (DEMO) {
    const exit = document.createElement('p');
    exit.style.cssText = 'text-align:left';
    exit.innerHTML = 'デモモードで動作中(Notionには保存されません) <a href="#" style="color:var(--accent)">Notion接続設定へ</a>';
    exit.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('mm_demo');
      location.reload();
    });
    footer.appendChild(exit);
  } else {
    // Notion連携の解除
    const foot = document.createElement('p');
    foot.innerHTML = '<a href="#" style="color:var(--sub)">Notion連携を解除</a>';
    foot.querySelector('a').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Notionとの連携を解除しますか?\n\nマインドマップのデータはNotionにそのまま残ります。\nもう一度トークンを設定すれば再開できます。')) return;
      try {
        await api.clearToken();
        location.reload();
      } catch (err) { toast('解除に失敗しました: ' + err.message); }
    });
    footer.appendChild(foot);
  }
}

// ---------- 最近使用したマップ ----------
function recordRecent(fileId) {
  try {
    let arr = JSON.parse(localStorage.getItem('mm_recent') || '[]');
    arr = [fileId, ...arr.filter(x => x !== fileId)].slice(0, 8);
    localStorage.setItem('mm_recent', JSON.stringify(arr));
  } catch {}
}

function renderRecents() {
  const sec = $('#recent-sec');
  sec.innerHTML = '';
  if (curFolder !== null) return; // トップ画面のみ
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('mm_recent') || '[]'); } catch {}
  const recents = ids
    .map(id => filesAll.find(f => f.id === id))
    .filter(f => f && f.kind !== 'フォルダ')
    .slice(0, 6);
  if (!recents.length) return;
  const h = document.createElement('h2');
  h.className = 'recent-title';
  h.textContent = '最近使用したマップ';
  sec.appendChild(h);
  const row = document.createElement('div');
  row.className = 'recent-row';
  for (const f of recents) {
    const d = new Date(f.edited);
    const c = document.createElement('button');
    c.className = 'recent-card';
    c.innerHTML = `<span class="rc-icon">${ICON.map}</span><span class="rc-body"><span class="rc-name"></span><span class="rc-meta">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span></span>`;
    c.querySelector('.rc-name').textContent = f.name || '無題';
    c.addEventListener('click', () => openEditor(f));
    row.appendChild(c);
  }
  sec.appendChild(row);
}

function buildFileCard(f) {
  const isFolder = f.kind === 'フォルダ';
  const card = document.createElement('div');
  card.className = 'file-card' + (isFolder ? ' folder' : '');
  card.dataset.id = f.id;
  const d = new Date(f.edited);
  const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const meta = isFolder
    ? `${filesAll.filter(x => x.parentId === f.id).length}個のアイテム`
    : `${f.nodeCount ?? '?'}トピック ・ ${dateStr}`;
  card.innerHTML = `<div class="fc-icon">${isFolder ? ICON.folder : ICON.map}</div>
    <div class="fc-name"></div>
    <div class="fc-meta">${meta}</div>`;
  card.querySelector('.fc-name').textContent = f.name || '無題';
  card.addEventListener('click', () => {
    if (suppressOpen) return;
    if (isFolder) { curFolder = f.id; renderFiles(); }
    else openEditor(f);
  });
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fileDrag = { id: f.id, sx: e.clientX, sy: e.clientY, moved: false };
  });
  return card;
}

// ---------- 右クリックメニュー ----------
function showCtxMenu(x, y, items) {
  const m = $('#ctx-menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'ctx-sep'; m.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { hideCtxMenu(); it.action(); });
    m.appendChild(b);
  }
  m.style.display = 'block';
  m.style.left = Math.min(x, innerWidth - 210) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 12) + 'px';
}
function hideCtxMenu() { $('#ctx-menu').style.display = 'none'; }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx-menu')) hideCtxMenu(); });

function showCreateMenu(x, y) {
  showCtxMenu(x, y, [
    { label: '新しいマインドマップ', action: () => createFileItem('マップ') },
    { label: '新しいファイル', action: () => createFileItem('フォルダ') },
  ]);
}

async function createFileItem(kind) {
  const label = kind === 'フォルダ' ? 'ファイルの名前' : 'マインドマップの名前';
  const name = await askName(label, kind === 'フォルダ' ? '新しいファイル' : '新しいマインドマップ');
  if (name == null) return;
  try {
    const created = await api.createFile({ name: name || '無題', kind, parentId: curFolder });
    filesAll.unshift(created.file);
    if (kind === 'フォルダ') renderFiles();
    else openEditor({ ...created.file, root: created.root });
  } catch (e) { toast('作成エラー: ' + e.message); }
}

el.files.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const card = e.target.closest('.file-card:not(.new)');
  if (!card) { showCreateMenu(e.clientX, e.clientY); return; }
  const f = filesAll.find(x => x.id === card.dataset.id);
  if (!f) return;
  const isFolder = f.kind === 'フォルダ';
  const items = [
    { label: '開く', action: () => { if (isFolder) { curFolder = f.id; renderFiles(); } else openEditor(f); } },
    { label: '名前を変更', action: async () => {
      const name = await askName('新しい名前', f.name);
      if (name == null || name === f.name) return;
      f.name = name;
      renderFiles();
      try { await api.updateFile(f.id, { name }); } catch (err) { toast('保存エラー: ' + err.message); }
    } },
  ];
  items.push({ label: '複製', action: async () => {
    toast('複製中…', 60000);
    try {
      const dup = await duplicateFile(f);
      filesAll = await api.listFiles();
      renderFiles();
      toast('複製しました');
      return dup;
    } catch (err) { toast('複製エラー: ' + err.message); }
  } });
  items.push({ label: '移動…', action: () => showMoveMenu(f, e.clientX, e.clientY) });
  items.push('-');
  items.push({ label: '削除', danger: true, action: async () => {
    const contents = isFolder ? filesAll.filter(x => x.parentId === f.id).length : 0;
    const msg = isFolder
      ? `「${f.name}」を削除しますか?(中の${contents}個のアイテムも削除されます)`
      : `「${f.name}」を削除しますか?(Notion側もゴミ箱に移動します)`;
    if (!confirm(msg)) return;
    const removeRec = (id) => {
      for (const x of filesAll.filter(y => y.parentId === id)) removeRec(x.id);
      filesAll = filesAll.filter(y => y.id !== id);
    };
    removeRec(f.id);
    renderFiles();
    try { await api.deleteFile(f.id); } catch (err) { toast('削除エラー: ' + err.message); }
  } });
  showCtxMenu(e.clientX, e.clientY, items);
});

// ---------- 複製 ----------
async function copyNodeImage(origNode, newId) {
  if (!origNode.image || !origNode.image.url) return;
  try {
    const r = await fetch(origNode.image.url);
    if (!r.ok) return;
    const blob = await r.blob();
    await api.uploadImage(newId, blob, origNode.image.name || 'image.png');
  } catch {}
}

async function duplicateMap(f, parentId, newName) {
  const nodes = await api.listNodes(f.id);
  const origIds = new Set(nodes.map(n => n.id));
  const created = await api.createFile({ name: newName, kind: 'マップ', parentId });
  const newFile = created.file;
  const autoRoot = created.root; // 自動生成される中心トピック
  const idMap = {};

  // 元の中心トピック → 自動生成されたrootに対応づけ、内容を移植
  const origTitle = nodes.find(n => !n.parentId && n.x == null) || nodes.find(n => !n.parentId);
  if (origTitle && autoRoot) {
    idMap[origTitle.id] = autoRoot.id;
    await api.updateNode(autoRoot.id, {
      name: origTitle.name, color: origTitle.color, note: origTitle.note,
      link: origTitle.link, collapsed: origTitle.collapsed,
    });
    await copyNodeImage(origTitle, autoRoot.id);
  }

  // 残りのノードを親→子の順で作成(親の新IDが決まってから子を作る)
  const queue = nodes.filter(n => !origTitle || n.id !== origTitle.id);
  let guard = 0;
  while (queue.length && guard < queue.length * 50 + 100) {
    guard++;
    const n = queue.shift();
    const hasParent = n.parentId && origIds.has(n.parentId);
    if (hasParent && !idMap[n.parentId]) { queue.push(n); continue; } // 親がまだ未作成
    const node = await api.createNode({
      name: n.name, parentId: hasParent ? idMap[n.parentId] : null, fileId: newFile.id,
      order: n.order, link: n.link, color: n.color, note: n.note,
      collapsed: n.collapsed, x: n.x, y: n.y, topicType: n.topicType,
    });
    idMap[n.id] = node.id;
    await copyNodeImage(n, node.id);
  }
  return newFile;
}

async function duplicateFolder(f, parentId, newName) {
  const created = await api.createFile({ name: newName, kind: 'フォルダ', parentId });
  const newFolder = created.file;
  const children = filesAll.filter(x => (x.parentId || null) === f.id);
  for (const c of children) {
    if (c.kind === 'フォルダ') await duplicateFolder(c, newFolder.id, c.name);
    else await duplicateMap(c, newFolder.id, c.name);
  }
  return newFolder;
}

function duplicateFile(f) {
  const name = (f.name || '無題') + 'のコピー';
  const parentId = f.parentId || null;
  return f.kind === 'フォルダ' ? duplicateFolder(f, parentId, name) : duplicateMap(f, parentId, name);
}

// 移動先のファイル(フォルダ)を選ぶメニュー
function showMoveMenu(f, x, y) {
  // 自分自身と自分の子孫フォルダには移動できない
  const excluded = new Set();
  if (f.kind === 'フォルダ') {
    const collect = (id) => {
      excluded.add(id);
      for (const c of filesAll.filter(v => v.kind === 'フォルダ' && v.parentId === id)) collect(c.id);
    };
    collect(f.id);
  }
  const cur = f.parentId || null;
  const items = [];
  const add = (label, id, depth) => items.push({
    label: '　'.repeat(depth) + label + (id === cur ? ' ✓' : ''),
    action: async () => {
      if ((f.parentId || null) === id) return;
      f.parentId = id;
      renderFiles();
      toast(id ? '移動しました' : 'トップに移動しました');
      try { await api.updateFile(f.id, { parentId: id }); } catch (err) { toast('保存エラー: ' + err.message); }
    },
  });
  add('トップ', null, 0);
  const walk = (pid, depth) => {
    for (const fl of filesAll.filter(v => v.kind === 'フォルダ' && (v.parentId || null) === pid)) {
      if (excluded.has(fl.id)) continue;
      add(fl.name || '無題', fl.id, depth);
      walk(fl.id, depth + 1);
    }
  };
  walk(null, 1);
  showCtxMenu(x, y, items);
}

// ---------- カードのドラッグ移動 (フォルダへ入れる) ----------
let fileDrag = null;

document.addEventListener('pointermove', (e) => {
  if (!fileDrag || !el.files.classList.contains('active')) return;
  const dist = Math.hypot(e.clientX - fileDrag.sx, e.clientY - fileDrag.sy);
  if (!fileDrag.moved && dist > 8) {
    fileDrag.moved = true;
    const f = filesAll.find(x => x.id === fileDrag.id);
    el.ghost.textContent = (f && f.name) || '';
    el.ghost.style.display = 'block';
    el.grid.querySelector(`[data-id="${CSS.escape(fileDrag.id)}"]`)?.classList.add('drag-src');
  }
  if (!fileDrag.moved) return;
  el.ghost.style.left = (e.clientX + 12) + 'px';
  el.ghost.style.top = (e.clientY + 12) + 'px';
  el.grid.querySelectorAll('.drop-into').forEach(c => c.classList.remove('drop-into'));
  document.querySelectorAll('#breadcrumb .crumb').forEach(c => c.style.outline = '');
  const t = fileDropTarget(e.clientX, e.clientY);
  if (t && t.card) t.card.classList.add('drop-into');
  if (t && t.crumb) t.crumb.style.outline = '2px solid #30bd66';
});

document.addEventListener('pointerup', async (e) => {
  if (!fileDrag) return;
  const wasDrag = fileDrag.moved;
  const dragId = fileDrag.id;
  fileDrag = null;
  el.ghost.style.display = 'none';
  el.grid.querySelectorAll('.drag-src, .drop-into').forEach(c => c.classList.remove('drag-src', 'drop-into'));
  document.querySelectorAll('#breadcrumb .crumb').forEach(c => c.style.outline = '');
  if (!wasDrag) return;
  suppressOpen = true;
  setTimeout(() => { suppressOpen = false; }, 100);
  const t = fileDropTarget(e.clientX, e.clientY);
  if (!t) return;
  const newParent = t.folderId;
  const f = filesAll.find(x => x.id === dragId);
  if (!f || f.id === newParent || (f.parentId || null) === newParent) return;
  // フォルダを自分の子孫に入れない
  let p = newParent;
  while (p) { if (p === f.id) return; const pf = filesAll.find(x => x.id === p); p = pf ? pf.parentId : null; }
  f.parentId = newParent;
  renderFiles();
  toast(newParent ? 'ファイルに移動しました' : 'トップに移動しました');
  try { await api.updateFile(f.id, { parentId: newParent }); } catch (err) { toast('保存エラー: ' + err.message); }
});

function fileDropTarget(x, y) {
  const elAt = document.elementFromPoint(x, y);
  if (!elAt) return null;
  const crumb = elAt.closest('#breadcrumb .crumb');
  if (crumb && !crumb.classList.contains('current')) {
    return { crumb, folderId: crumb.dataset.folderTarget || null };
  }
  const card = elAt.closest('.file-card:not(.new)');
  if (card && card.dataset.id !== (fileDrag && fileDrag.id)) {
    const f = filesAll.find(v => v.id === card.dataset.id);
    if (f && f.kind === 'フォルダ') return { card, folderId: f.id };
  }
  return null;
}

async function openEditor(file) {
  S.file = {
    id: file.id, name: file.name,
    layout: file.layout || 'マップ', theme: file.theme || 'ノーマル', bg: file.bg || 'ドット',
  };
  S.nodes.clear(); S.geo.clear(); S.sel = null; S.editing = null; S.idMap = {};
  undoStack.length = 0; // マップをまたいだUndoはしない
  if (!RO) recordRecent(file.id);
  el.title.value = file.name || '';
  el.title.readOnly = !!RO;
  S.inspTab = 'design';
  $('#btn-panel').classList.toggle('active', S.inspOpen);
  applyBg();
  showScreen('editor');
  el.layer.innerHTML = '';
  el.edges.innerHTML = '';
  toast('読み込み中…', 8000);
  try {
    let nodes = SNAPSHOT ? SNAPSHOT.nodes : (file.root ? [file.root] : await api.listNodes(file.id));
    if (!nodes.length) {
      const root = await api.createNode({ name: file.name || '中心トピック', fileId: file.id, order: 0, topicType: 'タイトルトピック' });
      nodes = [root];
    }
    for (const n of nodes) S.nodes.set(n.id, n);
    // 孤児ノード(親が消えている)はフローティング扱い
    for (const n of S.nodes.values()) {
      if (n.parentId && !S.nodes.has(n.parentId)) { n.parentId = null; if (n.x == null) { n.x = 300; n.y = 300; } }
    }
    const root = mainRoot();
    S.sel = root ? root.id : null;
    render();
    // 初回はサイズ確定後にもう一度レイアウト → フィット
    requestAnimationFrame(() => { render(); fitView(); });
    el.toast.classList.remove('visible');
  } catch (e) {
    toast('読み込みエラー: ' + e.message);
  }
  updateInspector();
}

// ============================================================
// セットアップ
// ============================================================
$('#token-save').addEventListener('click', async () => {
  const token = $('#token-input').value.trim();
  const err = $('#setup-error');
  if (!token) { err.textContent = 'シークレットを入力してください'; return; }
  $('#token-save').disabled = true;
  err.textContent = '';
  try {
    const r = await setupApi.saveToken(token);
    if (r.ok) {
      // デモで試していた場合はデモを抜けて本番として開き直す
      if (DEMO) { localStorage.removeItem('mm_demo'); location.reload(); return; }
      const st = await api.status();
      if (st.ok) {
        toast('接続しました!');
        openFilesScreen();
      } else if (st.needsDbSetup) {
        // トークンは有効。保存先DBをこれから作る
        showDbSetup();
      } else {
        err.textContent = '接続できましたが、Notionへのアクセスでエラーが発生しました (' + (st.error || '') + ')';
      }
    } else {
      err.textContent = 'トークンが正しくないようです (' + r.error + ')';
    }
  } catch (e) {
    err.textContent = 'エラー: ' + e.message;
  }
  $('#token-save').disabled = false;
});

// ステップ2: 複製されたテンプレートのDBを自動検出
async function showDbSetup() {
  showScreen('setup');
  $('#setup-step1').style.display = 'none';
  $('#setup-step2').style.display = '';
  const err = $('#setup2-error');
  const retry = $('#setup-retry');
  const status = $('#setup2-status');
  err.innerHTML = '';
  retry.style.display = 'none';
  status.textContent = 'テンプレートのデータベースを探しています…';
  try {
    const r = await setupApi.setupDetect();
    if (r.ok) {
      toast('セットアップが完了しました!');
      openFilesScreen();
      return;
    }
    status.textContent = '';
    err.innerHTML = 'データベースが見つかりませんでした。<br>複製したテンプレートのページ右上「…」→「接続」に、作成したインテグレーションが追加されているか確認してから、もう一度お試しください。';
  } catch (e) {
    status.textContent = '';
    err.textContent = 'エラー: ' + e.message;
  }
  retry.style.display = '';
}
$('#setup-retry').addEventListener('click', showDbSetup);

// デモリンクをセットアップ画面に追加
(() => {
  if (IS_EXT) return; // 拡張版にデモモードはない
  const card = document.querySelector('#setup-screen .setup-card');
  const p = document.createElement('p');
  p.style.cssText = 'margin-top:16px;font-size:12.5px;color:var(--sub)';
  p.innerHTML = '設定せずに試したい場合: <a href="#" style="color:var(--accent)">デモモードで開く</a>(ブラウザ内のみに保存)';
  p.querySelector('a').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.setItem('mm_demo', '1');
    location.reload();
  });
  card.appendChild(p);
})();

// ============================================================
// ログイン (公開URL用)
// ============================================================
function showLogin() {
  showScreen('login');
  $('#login-input').focus();
}

async function doLogin() {
  const pw = $('#login-input').value;
  const err = $('#login-error');
  err.textContent = '';
  if (!pw) return;
  try {
    const r = await jfetch('/api/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    if (r.ok === false && r.error === 'no_owner_password') {
      err.textContent = 'サーバー側にパスワードが設定されていません。';
      return;
    }
    location.reload();
  } catch (e) {
    err.textContent = e.status === 401 ? 'パスワードが違います。' : 'ログインできませんでした: ' + e.message;
  }
}
$('#login-btn').addEventListener('click', doLogin);
$('#login-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) doLogin();
});

// ============================================================
// 共有リンク
// ============================================================
const shareDialog = $('#share-dialog');

let SHARE_BASE = null; // 公開URL(サーバー設定)。未設定なら今開いているURLを使う

function shareUrl(key) {
  return `${(SHARE_BASE || location.origin).replace(/\/$/, '')}/?s=${key}`;
}

function renderShareRow(role, key) {
  const row = shareDialog.querySelector(`.share-row[data-role="${role}"]`);
  const input = row.querySelector('.share-link input');
  input.value = key ? shareUrl(key) : '';
  row.classList.toggle('has-link', !!key);
  row.querySelector('.share-create').textContent = key ? 'リンクを作り直す' : 'リンクを作る';
}

async function openShareDialog() {
  if (!S.file || RO) return;
  shareDialog.style.display = 'flex';
  renderShareRow('view', null);
  renderShareRow('edit', null);
  try {
    const r = await jfetch('/api/share/' + S.file.id);
    if (r.base) SHARE_BASE = r.base;
    renderShareRow('view', r.keys.view);
    renderShareRow('edit', r.keys.edit);
  } catch (e) {
    toast('共有リンクを読み込めませんでした: ' + e.message);
  }
}

shareDialog.addEventListener('click', async (e) => {
  const row = e.target.closest('.share-row');
  if (!row) return;
  const role = row.dataset.role;

  if (e.target.closest('.share-create')) {
    try {
      const r = await jfetch('/api/share/' + S.file.id, { method: 'POST', body: JSON.stringify({ role }) });
      if (r.base) SHARE_BASE = r.base;
      renderShareRow(role, r.key);
      await navigator.clipboard.writeText(shareUrl(r.key)).catch(() => {});
      toast('リンクを作成してコピーしました');
    } catch (err) { toast('作成できませんでした: ' + err.message); }
  }
  if (e.target.closest('.share-revoke')) {
    try {
      await jfetch('/api/share/' + S.file.id + '?role=' + role, { method: 'DELETE' });
      renderShareRow(role, null);
      toast('リンクを取り消しました');
    } catch (err) { toast('取り消せませんでした: ' + err.message); }
  }
  if (e.target.closest('.share-copy')) {
    const v = row.querySelector('.share-link input').value;
    if (!v) return;
    await navigator.clipboard.writeText(v).catch(() => {});
    toast('コピーしました');
  }
});

$('#share-close').addEventListener('click', () => { shareDialog.style.display = 'none'; });
shareDialog.addEventListener('mousedown', (e) => { if (e.target === shareDialog) shareDialog.style.display = 'none'; });
$('#btn-share').addEventListener('click', openShareDialog);

// ============================================================
// 起動
// ============================================================
(async function init() {
  // --- 共有リンク経由 ---
  if (SHARE_KEY) {
    try {
      const r = await jfetch('/api/share/resolve?s=' + encodeURIComponent(SHARE_KEY));
      SHARE_ROLE = r.role;
      SHARE_FILE = r.fileId;
      RO = SHARE_ROLE === 'view';
      if (SHARE_ROLE !== 'owner') {
        document.body.classList.add('shared');
        if (RO) document.body.classList.add('readonly');
        // バッジは「保存済み」の左に置く
        $('#sync-status').insertAdjacentHTML('beforebegin',
          `<span class="ro-badge">${RO ? '閲覧専用' : '編集できます'}</span>`);
      }
      const f = await api.getFile(SHARE_FILE);
      if (!f) throw new Error('共有されたマインドマップが見つかりませんでした');
      openEditor(f);
    } catch (e) {
      showScreen('setup');
      $('#setup-error').textContent =
        e.status === 404 ? 'このリンクは無効になっています。共有した人にもう一度リンクをもらってください。'
                         : '読み込みエラー: ' + e.message;
    }
    return;
  }

  try {
    const st = await api.status();
    if (!st.configured || !st.ok) {
      if (st.configured && st.needsDbSetup) { showDbSetup(); return; }
      showScreen('setup');
      if (st.configured && !st.ok) {
        $('#setup-error').textContent = 'Notionに接続できません(' + (st.error || '') + ')。トークンを再設定するか、データベースへの接続を確認してください。';
      }
      return;
    }
    openFilesScreen();
  } catch (e) {
    // 公開URLでログインしていない場合
    if (e.status === 401) { showLogin(); return; }
    showScreen('setup');
    $('#setup-error').textContent = 'サーバーに接続できません: ' + e.message;
  }
})();
