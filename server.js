#!/usr/bin/env node
// Notionマインドマップツール ローカルサーバー
// 依存パッケージなし (Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PORT = process.env.PORT || 8788;

// Vercel などのサーバーレス環境ではファイルに書けない。設定は環境変数から読む
const IS_SERVERLESS = !!process.env.VERCEL;

// DB IDはconfig.jsonに保存(初回セットアップで自動作成)。
// 未設定の場合は既定値(開発者自身のDB)にフォールバック
const FILES_DB_DEFAULT = '39ab16a9592380bea63ed1243dfe5020';
const NODES_DB_DEFAULT = '39ab16a9592380b89026e67a74e88b6c';
// DB IDが未設定なら、Notionから名前で自動検出した結果を使う(購入者に入力させないため)
let DB_CACHE = { filesDb: null, nodesDb: null };
const FILES_DB = () => loadConfig().filesDb || DB_CACHE.filesDb || FILES_DB_DEFAULT;
const NODES_DB = () => loadConfig().nodesDb || DB_CACHE.nodesDb || NODES_DB_DEFAULT;

async function ensureDbs() {
  const cfg = loadConfig();
  if (cfg.filesDb && cfg.nodesDb) return;           // 明示指定が最優先
  if (DB_CACHE.filesDb && DB_CACHE.nodesDb) return; // 検出済み
  if (!cfg.token) return;
  try { await detectDatabases(); } catch {}
}
const NOTION_VERSION = '2022-06-28';

// ---------- config ----------
function loadConfig() {
  const fromEnv = {};
  if (process.env.NOTION_TOKEN) fromEnv.token = process.env.NOTION_TOKEN;
  if (process.env.FILES_DB) fromEnv.filesDb = process.env.FILES_DB;
  if (process.env.NODES_DB) fromEnv.nodesDb = process.env.NODES_DB;
  if (IS_SERVERLESS) return fromEnv;
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return { ...file, ...fromEnv };
}
function saveConfig(cfg) {
  if (IS_SERVERLESS) return; // 読み取り専用。設定は環境変数で行う
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------- Notion API ----------
async function notion(pathname, method = 'GET', body = null, rawHeaders = {}) {
  const cfg = loadConfig();
  if (!cfg.token) { const e = new Error('no_token'); e.status = 401; throw e; }
  const res = await fetch('https://api.notion.com/v1' + pathname, {
    method,
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Notion-Version': NOTION_VERSION,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...rawHeaders,
    },
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || ('notion_error_' + res.status));
    e.status = res.status;
    e.code = data.code;
    throw e;
  }
  return data;
}

// ---------- property helpers ----------
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
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notion(`/databases/${dbId}/query`, 'POST', body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ---------- 初回セットアップ: 複製されたテンプレートのDBを自動検出 ----------
async function detectDatabases() {
  const data = await notion('/search', 'POST', {
    filter: { value: 'database', property: 'object' },
    page_size: 100,
  });
  const byTitle = (t) => data.results
    .filter(db => plain(db.title) === t && !db.archived && !db.in_trash)
    .sort((a, b) => (b.last_edited_time || '').localeCompare(a.last_edited_time || ''))[0];
  const files = byTitle('DB_マインドマップファイル');
  const nodes = byTitle('DB_マインドマップ');
  if (!files || !nodes) return { ok: false, error: 'not_found' };
  DB_CACHE = { filesDb: files.id, nodesDb: nodes.id };
  const cfg = loadConfig();
  cfg.filesDb = files.id;
  cfg.nodesDb = nodes.id;
  saveConfig(cfg); // サーバーレスでは保存されないのでDB_CACHEが効く
  return { ok: true, filesDb: files.id, nodesDb: nodes.id };
}

// ---------- アウトライン同期 (マップ構造をNotionページ本文に書き出す) ----------
async function syncOutline(fileId) {
  const nodePages = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: fileId } });
  const nodes = nodePages.map(parseNode);

  // 既存の本文を削除(本文はアプリが自動生成する領域)
  const oldBlocks = [];
  let cursor;
  do {
    const data = await notion(`/blocks/${fileId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    oldBlocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  for (const b of oldBlocks) await notion(`/blocks/${b.id}`, 'DELETE');

  // ツリー構築
  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parentId || 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const roots = byParent.get('root') || [];
  const main = roots.find(r => r.x == null) || roots[0];
  // 中心トピック名はページタイトルと同じなので、その子＋フローティングをトップレベルに
  const top = [...(main ? (byParent.get(main.id) || []) : []), ...roots.filter(r => r !== main)];

  const toBlock = (n) => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [{ type: 'text', text: { content: n.name || '無題', ...(n.link ? { link: { url: n.link } } : {}) } }],
    },
  });
  // ネスト制限を避けて1階層ずつ追加(100ブロック上限のためチャンク分割)
  const appendLevel = async (parentBlockId, list) => {
    if (!list.length) return;
    const created = [];
    for (let i = 0; i < list.length; i += 90) {
      const chunk = list.slice(i, i + 90);
      const res = await notion(`/blocks/${parentBlockId}/children`, 'PATCH', { children: chunk.map(toBlock) });
      created.push(...res.results);
    }
    for (let i = 0; i < list.length; i++) {
      const kids = byParent.get(list[i].id) || [];
      if (kids.length) await appendLevel(created[i].id, kids);
    }
  };
  await appendLevel(fileId, top);
  return { ok: true, nodes: nodes.length };
}

// ---------- request handling ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------- 共有リンク / 所有者ログイン ----------
// 共有キーはNotionのファイルDB(共有閲覧キー/共有編集キー)に保存する。
// リンクを作り直す・取り消すのはNotion側の値を書き換えるだけなので、追加のDBは不要。
const crypto = require('crypto');

const SESSION_COOKIE = 'nm-auth';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function sessionSecret() {
  const explicit = process.env.SESSION_SECRET || loadConfig().sessionSecret;
  if (explicit) return explicit;
  // 未設定ならパスワードから作る(購入者に長い文字列を用意させないため)
  const pw = process.env.OWNER_PASSWORD || loadConfig().ownerPassword;
  if (pw) return crypto.createHmac('sha256', 'neumind-session').update(pw).digest('hex');
  return 'neumind-dev-secret';
}
function ownerPassword() {
  return process.env.OWNER_PASSWORD || loadConfig().ownerPassword || null;
}
function signOwner() {
  return crypto.createHmac('sha256', sessionSecret()).update('owner').digest('hex');
}
function isOwnerToken(token) {
  if (!token) return false;
  const expected = signOwner();
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function ownerCookie(token) {
  const secure = IS_SERVERLESS ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Path=/${secure}`;
}

const SHARE_PROPS = { view: '共有閲覧キー', edit: '共有編集キー' };

// 共有リンクの土台URL。ローカルで発行してもlocalhostのリンクにならないようにする
function publicBase(req) {
  const explicit = process.env.PUBLIC_BASE_URL || loadConfig().publicBase;
  if (explicit) return explicit.replace(/\/$/, '');
  // 未設定なら、今アクセスされているURLをそのまま使う
  if (req && req.headers.host && !/^localhost|^127\.|^\[::1\]/.test(req.headers.host)) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return proto + '://' + req.headers.host;
  }
  return null;
}
const newShareKey = () => crypto.randomBytes(16).toString('base64url');

// 共有キー → { fileId, role } の解決。Notionへの問い合わせを毎回しないよう短時間だけ覚える
const shareCache = new Map(); // key -> { value, at }
const SHARE_TTL = 10 * 1000; // 取り消しが最大10秒で効くようにする

async function resolveShare(key) {
  if (!key) return null;
  const hit = shareCache.get(key);
  if (hit && Date.now() - hit.at < SHARE_TTL) return hit.value;

  let value = null;
  for (const role of ['edit', 'view']) {
    let pages;
    try {
      pages = await queryAll(FILES_DB(), {
        property: SHARE_PROPS[role],
        rich_text: { equals: key },
      });
    } catch (e) {
      // 列自体が無い = まだ一度も共有していないNotion。作ってから続ける
      if (e.status === 400) { await ensureShareProps(); pages = []; }
      else throw e;
    }
    const pg = pages.find(p => !p.archived && !p.in_trash);
    if (pg) { value = { fileId: pg.id, role }; break; }
  }
  shareCache.set(key, { value, at: Date.now() });
  return value;
}

// 共有キーの列が無いNotion(古いテンプレートを複製済みの人)には、必要になった時に自動で作る
let sharePropsReady = false;
async function ensureShareProps() {
  if (sharePropsReady) return;
  const db = await notion(`/databases/${FILES_DB()}`);
  const missing = {};
  for (const name of Object.values(SHARE_PROPS)) {
    if (!db.properties[name]) missing[name] = { rich_text: {} };
  }
  if (Object.keys(missing).length) {
    await notion(`/databases/${FILES_DB()}`, 'PATCH', { properties: missing });
    console.log('共有キーの列を追加しました:', Object.keys(missing).join(', '));
  }
  sharePropsReady = true;
}

function shareKeysOf(pg) {
  const p = pg.properties;
  return {
    view: plain(p[SHARE_PROPS.view] && p[SHARE_PROPS.view].rich_text) || null,
    edit: plain(p[SHARE_PROPS.edit] && p[SHARE_PROPS.edit].rich_text) || null,
  };
}

/** ノードが指定のマップに属しているか（編集リンクの範囲チェック） */
async function nodeBelongsTo(nodeId, fileId) {
  try {
    const pg = await notion(`/pages/${nodeId}`);
    return parseNode(pg).fileId === fileId;
  } catch { return false; }
}

/**
 * リクエストの権限を判定する。
 *  - owner : 所有者（ローカル起動、またはログイン済み）。全機能
 *  - share : 共有リンク経由。role が view なら読み取りのみ、edit ならそのマップのみ編集可
 */
async function authOf(req, url) {
  // ローカル起動（自分のMac）は今まで通り無条件で所有者
  if (!IS_SERVERLESS) {
    const host = (req.headers.host || '').split(':')[0];
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { owner: true };
  }
  if (isOwnerToken(parseCookies(req)[SESSION_COOKIE])) return { owner: true };

  const key = req.headers['x-share-key'] || url.searchParams.get('s');
  const share = await resolveShare(key);
  if (share) return { owner: false, share };
  return { owner: false };
}

/** 共有リンクで許可される操作か判定する */
async function allowedForShare(share, method, url, parts, body) {
  const { fileId, role } = share;
  const readOnly = role === 'view';

  // 読み取り: そのマップ本体とノード一覧のみ
  if (method === 'GET') {
    if (parts[1] === 'files' && parts[2] === fileId && !parts[3]) return true;
    if (parts[1] === 'nodes' && parts[2] === fileId && !parts[3]) return true;
    if (parts[1] === 'nodes' && parts[2] && parts[3] === 'refresh') {
      return await nodeBelongsTo(parts[2], fileId);
    }
    return false;
  }
  if (readOnly) return false;

  // 編集リンク: 対象マップの範囲内だけ
  if (parts[1] === 'files' && parts[2] === fileId && method === 'PATCH') return true;
  if (url.pathname === '/api/outline' && method === 'POST') return body && body.fileId === fileId;
  if (url.pathname === '/api/nodes' && method === 'POST') return body && body.fileId === fileId;
  if (parts[1] === 'nodes' && parts[2] && (method === 'PATCH' || method === 'DELETE' || parts[3] === 'restore' || parts[3] === 'image')) {
    // 付け替え先も同じマップ内に限る
    if (body && 'fileId' in body && body.fileId !== fileId) return false;
    return await nodeBelongsTo(parts[2], fileId);
  }
  return false;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // 事前にボディを読む(権限判定に使うため)。画像アップロードはバイナリなのでBufferのまま持つ
  let body = null;
  let rawBuf = null;
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    rawBuf = await readBody(req);
    // ブラウザのfetchはContent-Typeを付けないとtext/plainになるため、
    // 画像などのバイナリ以外はとりあえずJSONとして読む
    const ctype = req.headers['content-type'] || '';
    const isBinary = ctype.startsWith('image/') || ctype.startsWith('multipart/') || ctype.startsWith('application/octet-stream');
    if (rawBuf.length && !isBinary) {
      try { body = JSON.parse(rawBuf.toString()); } catch { body = null; }
    }
  }
  req._rawBuf = rawBuf;
  req._body = body;

  if (url.pathname === '/api/ping') return json(res, 200, { ok: true });

  await ensureDbs();

  // --- 所有者ログイン ---
  if (url.pathname === '/api/login' && method === 'POST') {
    const pw = ownerPassword();
    if (!pw) return json(res, 200, { ok: false, error: 'no_owner_password' });
    if (!body || body.password !== pw) return json(res, 401, { error: 'invalid' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': ownerCookie(signOwner()) });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/logout' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/` });
    return res.end(JSON.stringify({ ok: true }));
  }

  // --- 権限判定 ---
  const auth = await authOf(req, url);

  // 共有リンクの中身(どのマップか・閲覧か編集か)を返す
  // 所有者が自分のリンクを開いた場合は role=owner(制限なし)
  if (url.pathname === '/api/share/resolve' && method === 'GET') {
    const key = req.headers['x-share-key'] || url.searchParams.get('s');
    const sh = auth.share || await resolveShare(key);
    if (!sh) return json(res, 404, { error: 'invalid_link' });
    return json(res, 200, { fileId: sh.fileId, role: auth.owner ? 'owner' : sh.role });
  }

  if (!auth.owner) {
    if (!auth.share) return json(res, 401, { error: 'unauthorized' });
    const ok = await allowedForShare(auth.share, method, url, parts, body);
    if (!ok) return json(res, 403, { error: auth.share.role === 'view' ? 'read_only' : 'out_of_scope' });
  }

  // --- 共有リンクの発行・取り消し(所有者のみ) ---
  if (parts[1] === 'share' && parts[2] && parts[2] !== 'resolve') {
    const fileId = parts[2];
    await ensureShareProps();
    if (method === 'GET') {
      const pg = await notion(`/pages/${fileId}`);
      return json(res, 200, { keys: shareKeysOf(pg), base: publicBase(req) });
    }
    if (method === 'POST') {
      const role = (body && body.role) === 'edit' ? 'edit' : 'view';
      const key = newShareKey();
      await notion(`/pages/${fileId}`, 'PATCH', { properties: { [SHARE_PROPS[role]]: textProp(key) } });
      shareCache.clear();
      return json(res, 200, { role, key, base: publicBase(req) });
    }
    if (method === 'DELETE') {
      const role = url.searchParams.get('role') === 'edit' ? 'edit' : 'view';
      await notion(`/pages/${fileId}`, 'PATCH', { properties: { [SHARE_PROPS[role]]: textProp('') } });
      shareCache.clear();
      return json(res, 200, { ok: true });
    }
  }

  // --- config ---
  if (url.pathname === '/api/status') {
    const cfg = loadConfig();
    if (!cfg.token) return json(res, 200, { configured: false });
    try {
      await notion(`/databases/${NODES_DB()}`);
      return json(res, 200, { configured: true, ok: true });
    } catch (e) {
      // トークンは有効だがDBが見つからない → 初回セットアップ(DB作成)が必要
      if (e.status === 404) {
        return json(res, 200, { configured: true, ok: false, needsDbSetup: true, error: e.code || e.message });
      }
      return json(res, 200, { configured: true, ok: false, error: e.code || e.message });
    }
  }
  if (url.pathname === '/api/token' && method === 'DELETE') {
    const cfg = loadConfig();
    delete cfg.token;
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/token' && method === 'POST') {
    const body = req._body || {};
    const token = (body.token || '').trim();
    if (!token) return json(res, 400, { error: 'token required' });
    // トークン自体の有効性を確認(DBはまだ無くてもよい)
    try {
      const res2 = await fetch('https://api.notion.com/v1/users/me', {
        headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
      });
      if (!res2.ok) {
        const d = await res2.json().catch(() => ({}));
        return json(res, 200, { ok: false, error: d.code || res2.status });
      }
    } catch (e) { return json(res, 200, { ok: false, error: String(e) }); }
    const cfg = loadConfig(); cfg.token = token; saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  // --- アウトライン同期 ---
  if (url.pathname === '/api/outline' && method === 'POST') {
    const body = req._body || {};
    if (!body.fileId) return json(res, 400, { error: 'fileId required' });
    try {
      return json(res, 200, await syncOutline(body.fileId));
    } catch (e) {
      console.error('outline error', e.message);
      return json(res, 200, { ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }

  // --- 初回セットアップ: テンプレートのDBを自動検出 ---
  if (url.pathname === '/api/setup/detect' && method === 'POST') {
    try {
      return json(res, 200, await detectDatabases());
    } catch (e) {
      console.error('setup error', e);
      return json(res, 200, { ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }

  // --- files ---
  if (url.pathname === '/api/files' && method === 'GET') {
    const pages = await queryAll(FILES_DB());
    const files = pages.map(parseFile);
    files.sort((a, b) => b.edited.localeCompare(a.edited));
    return json(res, 200, { files });
  }
  if (url.pathname === '/api/files' && method === 'POST') {
    const body = req._body || {};
    const kind = body.kind || 'マップ';
    const name = body.name || (kind === 'フォルダ' ? '新しいファイル' : '無題のマインドマップ');
    const pg = await notion('/pages', 'POST', {
      parent: { database_id: FILES_DB() },
      properties: fileProps({ name, kind, parentId: body.parentId || null }),
    });
    let root = null;
    if (kind !== 'フォルダ') {
      const rootPg = await notion('/pages', 'POST', {
        parent: { database_id: NODES_DB() },
        properties: nodeProps({ name, fileId: pg.id, order: 0, topicType: 'タイトルトピック' }),
      });
      root = parseNode(rootPg);
    }
    return json(res, 200, { file: parseFile(pg), root });
  }
  if (parts[1] === 'files' && parts[2] && method === 'GET') {
    const pg = await notion(`/pages/${parts[2]}`);
    return json(res, 200, { file: parseFile(pg) });
  }
  if (parts[1] === 'files' && parts[2] && method === 'PATCH') {
    const body = req._body || {};
    const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { properties: fileProps(body) });
    return json(res, 200, { file: parseFile(pg) });
  }
  if (parts[1] === 'files' && parts[2] && method === 'DELETE') {
    // フォルダなら中身も再帰的に、マップならノードもすべてアーカイブ
    const deleteFileRec = async (id) => {
      const inner = await queryAll(FILES_DB(), { property: '親ファイル', relation: { contains: id } });
      for (const f of inner) await deleteFileRec(f.id);
      const nodes = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: id } });
      for (const n of nodes) await notion(`/pages/${n.id}`, 'PATCH', { archived: true });
      await notion(`/pages/${id}`, 'PATCH', { archived: true });
    };
    await deleteFileRec(parts[2]);
    return json(res, 200, { ok: true });
  }

  // --- nodes ---
  if (parts[1] === 'nodes' && parts[2] && parts[3] === 'image' && method === 'POST') {
    // 画像アップロード: バイナリボディ + x-filename ヘッダ
    const buf = req._rawBuf;
    const filename = decodeURIComponent(req.headers['x-filename'] || 'image.png');
    const contentType = req.headers['content-type'] || 'image/png';
    const up = await notion('/file_uploads', 'POST', { mode: 'single_part', filename });
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: contentType }), filename);
    const upRes = await fetch(`https://api.notion.com/v1/file_uploads/${up.id}/send`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + loadConfig().token, 'Notion-Version': NOTION_VERSION },
      body: fd,
    });
    if (!upRes.ok) {
      const d = await upRes.json().catch(() => ({}));
      return json(res, 502, { error: d.message || 'upload failed' });
    }
    const pg = await notion(`/pages/${parts[2]}`, 'PATCH', {
      properties: { '画像': { files: [{ type: 'file_upload', file_upload: { id: up.id }, name: filename }] } },
    });
    return json(res, 200, { node: parseNode(pg) });
  }
  if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'GET') {
    // GET /api/nodes/:fileId → そのファイルの全ノード
    const pages = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: parts[2] } });
    return json(res, 200, { nodes: pages.map(parseNode) });
  }
  if (url.pathname === '/api/nodes' && method === 'POST') {
    const body = req._body || {};
    const pg = await notion('/pages', 'POST', {
      parent: { database_id: NODES_DB() },
      properties: nodeProps(body),
    });
    return json(res, 200, { node: parseNode(pg) });
  }
  if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'PATCH') {
    const body = req._body || {};
    const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { properties: nodeProps(body) });
    return json(res, 200, { node: parseNode(pg) });
  }
  if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'DELETE') {
    await notion(`/pages/${parts[2]}`, 'PATCH', { archived: true });
    return json(res, 200, { ok: true });
  }
  // 画像URLの再取得(署名URL期限切れ対策)
  if (parts[1] === 'nodes' && parts[2] && parts[3] === 'refresh' && method === 'GET') {
    const pg = await notion(`/pages/${parts[2]}`);
    return json(res, 200, { node: parseNode(pg) });
  }
  // 削除の取り消し(⌘Z): アーカイブ解除
  if (parts[1] === 'nodes' && parts[2] && parts[3] === 'restore' && method === 'POST') {
    const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { archived: false });
    return json(res, 200, { node: parseNode(pg) });
  }

  json(res, 404, { error: 'not found' });
}

/** リクエスト処理本体。ローカルのhttpサーバーからも Vercel の関数からも呼ぶ */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    // static (Vercel では静的配信が先に処理するため、ここに来るのはローカル起動時)
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, e.status === 401 ? 401 : 500, { error: e.message, code: e.code });
  }
}

module.exports = handleRequest;

// 直接実行されたときだけローカルサーバーとして待ち受ける
if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`NeuMind: http://localhost:${PORT}`);
  });
}
