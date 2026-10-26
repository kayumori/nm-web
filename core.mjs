// NeuMind の API 本体。
// ローカルサーバー(server.js)と Cloudflare Pages の関数(functions/api/[[path]].js)の
// どちらからも同じコードを使う。標準の Request / Response だけで書く(Node固有の機能は使わない)。

const NOTION_VERSION = '2022-06-28';

// 既定のDB ID(未設定時のフォールバック)
const FILES_DB_DEFAULT = '';
const NODES_DB_DEFAULT = '';

const SESSION_COOKIE = 'nm-auth';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const SHARE_PROPS = { view: '共有閲覧キー', edit: '共有編集キー' };
const SHARE_TTL = 10 * 1000; // 取り消しが最大10秒で効くようにする

/**
 * API を作る。
 * @param {object} opts
 * @param {object} opts.env     環境変数(NOTION_TOKEN など)
 * @param {object} opts.store   設定の読み書き { read(), write(cfg) }。保存できない環境では write を空にする
 * @param {'local'|'hosted'} opts.mode  local はローカル起動(自分のMac)、hosted は公開サーバー
 */
export function createApi({ env = {}, store = {}, mode = 'hosted' } = {}) {
  const isHosted = mode === 'hosted';
  const readStore = store.read || (() => ({}));
  const writeStore = store.write || (() => {});

  // 検出済みDB・共有キーの短期キャッシュ(インスタンスごと)
  let dbCache = { filesDb: null, nodesDb: null };
  let sharePropsReady = false;
  const shareCache = new Map();

  // ---------- config ----------
  function loadConfig() {
    const fromEnv = {};
    if (env.NOTION_TOKEN) fromEnv.token = env.NOTION_TOKEN;
    if (env.FILES_DB) fromEnv.filesDb = env.FILES_DB;
    if (env.NODES_DB) fromEnv.nodesDb = env.NODES_DB;
    if (env.OWNER_PASSWORD) fromEnv.ownerPassword = env.OWNER_PASSWORD;
    if (env.SESSION_SECRET) fromEnv.sessionSecret = env.SESSION_SECRET;
    if (env.PUBLIC_BASE_URL) fromEnv.publicBase = env.PUBLIC_BASE_URL;
    if (isHosted) return fromEnv;
    return { ...readStore(), ...fromEnv };
  }
  function saveConfig(cfg) {
    if (isHosted) return; // 公開サーバーはファイルに書けない。設定は環境変数で行う
    writeStore(cfg);
  }

  const FILES_DB = () => loadConfig().filesDb || dbCache.filesDb || FILES_DB_DEFAULT;
  const NODES_DB = () => loadConfig().nodesDb || dbCache.nodesDb || NODES_DB_DEFAULT;

  async function ensureDbs() {
    const cfg = loadConfig();
    if (cfg.filesDb && cfg.nodesDb) return;
    if (dbCache.filesDb && dbCache.nodesDb) return;
    if (!cfg.token) return;
    try { await detectDatabases(); } catch {}
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
      hasFiles: !!(p['添付'] && p['添付'].checkbox),
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
    if ('hasFiles' in d) props['添付'] = { checkbox: !!d.hasFiles };
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
    // 検索結果を全ページ送りして探す。
    // (DBを多く持っている人は、先頭100件だけでは目的のDBに届かない)
    const results = [];
    let cursor;
    do {
      const data = await notion('/search', 'POST', {
        filter: { value: 'database', property: 'object' },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      results.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    const byTitle = (t) => results
      .filter(db => plain(db.title) === t && !db.archived && !db.in_trash)
      .sort((a, b) => (b.last_edited_time || '').localeCompare(a.last_edited_time || ''))[0];
    const files = byTitle('DB_マインドマップファイル');
    const nodes = byTitle('DB_マインドマップ');
    if (!files || !nodes) return { ok: false, error: 'not_found' };
    dbCache = { filesDb: files.id, nodesDb: nodes.id };
    const cfg = loadConfig();
    cfg.filesDb = files.id;
    cfg.nodesDb = nodes.id;
    saveConfig(cfg); // 公開サーバーでは保存されないので dbCache が効く
    return { ok: true, filesDb: files.id, nodesDb: nodes.id };
  }

  // ---------- アウトライン同期 ----------
  /** 中心トピック = 位置を持たない親なしトピックのうち、子孫がいちばん多いもの */
  function pickMainRoot(roots, byParent) {
    const size = (id) => (byParent.get(id) || []).reduce((a, c) => a + 1 + size(c.id), 0);
    const cands = roots.filter(r => r.x == null);
    if (!cands.length) return roots[0] || null;
    return cands.reduce((best, r) => (size(r.id) > size(best.id) ? r : best));
  }

  async function syncOutline(fileId) {
    const nodePages = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: fileId } });
    const nodes = nodePages.map(parseNode);

    const oldBlocks = [];
    let cursor;
    do {
      const data = await notion(`/blocks/${fileId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
      oldBlocks.push(...data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    for (const b of oldBlocks) await notion(`/blocks/${b.id}`, 'DELETE');

    const byParent = new Map();
    for (const n of nodes) {
      const k = n.parentId || 'root';
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k).push(n);
    }
    for (const list of byParent.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const roots = byParent.get('root') || [];
    const main = pickMainRoot(roots, byParent);
    // 位置を持たない親なしトピックは、親が消されて残ったもの。書き出さない
    const top = [...(main ? (byParent.get(main.id) || []) : []), ...roots.filter(r => r !== main && r.x != null)];

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

  // ---------- 共有リンク / 所有者ログイン ----------
  // 署名は WebCrypto を使う(Node でも Cloudflare でも同じコードで動く)
  const enc = new TextEncoder();
  async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  /** 長さと内容を、途中で打ち切らずに比べる(タイミングで中身を推測されないため) */
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function sessionSecret() {
    const cfg = loadConfig();
    if (cfg.sessionSecret) return cfg.sessionSecret;
    // 未設定ならパスワードから作る(購入者に長い文字列を用意させないため)
    if (cfg.ownerPassword) return await hmacHex('neumind-session', cfg.ownerPassword);
    return 'neumind-dev-secret';
  }
  const ownerPassword = () => loadConfig().ownerPassword || null;
  const signOwner = async () => await hmacHex(await sessionSecret(), 'owner');
  async function isOwnerToken(token) {
    if (!token) return false;
    return safeEqual(token, await signOwner());
  }
  function parseCookies(request) {
    const out = {};
    for (const part of (request.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function ownerCookie(token) {
    const secure = isHosted ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}; Path=/${secure}`;
  }

  /** 共有リンクの土台URL。ローカルで発行してもlocalhostのリンクにならないようにする */
  function publicBase(request) {
    const explicit = loadConfig().publicBase;
    if (explicit) return explicit.replace(/\/$/, '');
    const host = request.headers.get('host') || new URL(request.url).host;
    if (host && !/^localhost|^127\.|^\[::1\]/.test(host)) {
      const proto = request.headers.get('x-forwarded-proto') || 'https';
      return proto + '://' + host;
    }
    return null;
  }
  function newShareKey() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function resolveShare(key) {
    if (!key) return null;
    const hit = shareCache.get(key);
    if (hit && Date.now() - hit.at < SHARE_TTL) return hit.value;

    let value = null;
    for (const role of ['edit', 'view']) {
      let pages;
      try {
        pages = await queryAll(FILES_DB(), { property: SHARE_PROPS[role], rich_text: { equals: key } });
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

  async function ensureShareProps() {
    if (sharePropsReady) return;
    const db = await notion(`/databases/${FILES_DB()}`);
    const missing = {};
    for (const name of Object.values(SHARE_PROPS)) {
      if (!db.properties[name]) missing[name] = { rich_text: {} };
    }
    if (Object.keys(missing).length) {
      await notion(`/databases/${FILES_DB()}`, 'PATCH', { properties: missing });
    }
    sharePropsReady = true;
  }

  // 添付ファイルの有無を示す列。無ければ必要になった時に作る
  let attachPropReady = false;
  async function ensureAttachProp() {
    if (attachPropReady) return;
    try {
      const db = await notion(`/databases/${NODES_DB()}`);
      if (!db.properties['添付']) {
        await notion(`/databases/${NODES_DB()}`, 'PATCH', { properties: { '添付': { checkbox: {} } } });
      }
      attachPropReady = true;
    } catch {}
  }

  /** トピックに添付されたファイル一覧(ページ本文のファイルブロック) */
  async function listAttachments(nodeId) {
    const out = [];
    let cursor;
    do {
      const data = await notion(`/blocks/${nodeId}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
      for (const b of data.results) {
        if (b.type !== 'file') continue;
        const f = b.file || {};
        out.push({
          id: b.id,
          name: f.name || plain(f.caption) || 'ファイル',
          url: (f.file && f.file.url) || (f.external && f.external.url) || null,
        });
      }
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  function shareKeysOf(pg) {
    const p = pg.properties;
    return {
      view: plain(p[SHARE_PROPS.view] && p[SHARE_PROPS.view].rich_text) || null,
      edit: plain(p[SHARE_PROPS.edit] && p[SHARE_PROPS.edit].rich_text) || null,
    };
  }

  async function nodeBelongsTo(nodeId, fileId) {
    try {
      const pg = await notion(`/pages/${nodeId}`);
      return parseNode(pg).fileId === fileId;
    } catch { return false; }
  }

  async function authOf(request, url) {
    // ローカル起動(自分のMac)は今まで通り無条件で所有者
    if (!isHosted) {
      const host = (request.headers.get('host') || '').split(':')[0];
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { owner: true };
    }
    if (await isOwnerToken(parseCookies(request)[SESSION_COOKIE])) return { owner: true };

    const key = request.headers.get('x-share-key') || url.searchParams.get('s');
    const share = await resolveShare(key);
    if (share) return { owner: false, share };
    return { owner: false };
  }

  async function allowedForShare(share, method, url, parts, body) {
    const { fileId, role } = share;
    const readOnly = role === 'view';

    if (method === 'GET') {
      if (parts[1] === 'files' && parts[2] === fileId && !parts[3]) return true;
      if (parts[1] === 'nodes' && parts[2] === fileId && !parts[3]) return true;
      if (parts[1] === 'nodes' && parts[2] && (parts[3] === 'refresh' || parts[3] === 'attachments')) {
        return await nodeBelongsTo(parts[2], fileId);
      }
      return false;
    }
    if (readOnly) return false;

    if (parts[1] === 'files' && parts[2] === fileId && method === 'PATCH') return true;
    if (url.pathname === '/api/outline' && method === 'POST') return body && body.fileId === fileId;
    if (url.pathname === '/api/nodes' && method === 'POST') return body && body.fileId === fileId;
    if (parts[1] === 'nodes' && parts[2] && (method === 'PATCH' || method === 'DELETE' || parts[3] === 'restore' || parts[3] === 'image' || parts[3] === 'attachments')) {
      if (body && 'fileId' in body && body.fileId !== fileId) return false;
      return await nodeBelongsTo(parts[2], fileId);
    }
    return false;
  }

  // ---------- 応答の作り方 ----------
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

  /** /api/* の処理本体。Response を返す */
  async function handleApi(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = request.method;

    // 事前にボディを読む(権限判定に使うため)。画像アップロードはバイナリのまま持つ
    let body = null;
    let rawBuf = null;
    if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
      rawBuf = new Uint8Array(await request.arrayBuffer());
      const ctype = request.headers.get('content-type') || '';
      const isBinary = ctype.startsWith('image/') || ctype.startsWith('multipart/') || ctype.startsWith('application/octet-stream');
      if (rawBuf.length && !isBinary) {
        try { body = JSON.parse(new TextDecoder().decode(rawBuf)); } catch { body = null; }
      }
    }

    if (url.pathname === '/api/ping') return json(200, { ok: true });

    await ensureDbs();

    // --- 所有者ログイン ---
    if (url.pathname === '/api/login' && method === 'POST') {
      const pw = ownerPassword();
      if (!pw) return json(200, { ok: false, error: 'no_owner_password' });
      if (!body || !safeEqual(String(body.password || ''), pw)) return json(401, { error: 'invalid' });
      return json(200, { ok: true }, { 'Set-Cookie': ownerCookie(await signOwner()) });
    }
    if (url.pathname === '/api/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/` });
    }

    // --- 権限判定 ---
    const auth = await authOf(request, url);

    if (url.pathname === '/api/share/resolve' && method === 'GET') {
      const key = request.headers.get('x-share-key') || url.searchParams.get('s');
      const sh = auth.share || await resolveShare(key);
      if (!sh) return json(404, { error: 'invalid_link' });
      return json(200, { fileId: sh.fileId, role: auth.owner ? 'owner' : sh.role });
    }

    if (!auth.owner) {
      if (!auth.share) return json(401, { error: 'unauthorized' });
      const ok = await allowedForShare(auth.share, method, url, parts, body);
      if (!ok) return json(403, { error: auth.share.role === 'view' ? 'read_only' : 'out_of_scope' });
    }

    // --- 共有リンクの発行・取り消し(所有者のみ) ---
    if (parts[1] === 'share' && parts[2] && parts[2] !== 'resolve') {
      const fileId = parts[2];
      await ensureShareProps();
      if (method === 'GET') {
        const pg = await notion(`/pages/${fileId}`);
        return json(200, { keys: shareKeysOf(pg), base: publicBase(request) });
      }
      if (method === 'POST') {
        const role = (body && body.role) === 'edit' ? 'edit' : 'view';
        const key = newShareKey();
        await notion(`/pages/${fileId}`, 'PATCH', { properties: { [SHARE_PROPS[role]]: textProp(key) } });
        shareCache.clear();
        return json(200, { role, key, base: publicBase(request) });
      }
      if (method === 'DELETE') {
        const role = url.searchParams.get('role') === 'edit' ? 'edit' : 'view';
        await notion(`/pages/${fileId}`, 'PATCH', { properties: { [SHARE_PROPS[role]]: textProp('') } });
        shareCache.clear();
        return json(200, { ok: true });
      }
    }

    // --- config ---
    if (url.pathname === '/api/status') {
      const cfg = loadConfig();
      if (!cfg.token) return json(200, { configured: false });
      try {
        await notion(`/databases/${NODES_DB()}`);
        return json(200, { configured: true, ok: true });
      } catch (e) {
        if (e.status === 404) {
          return json(200, { configured: true, ok: false, needsDbSetup: true, error: e.code || e.message });
        }
        return json(200, { configured: true, ok: false, error: e.code || e.message });
      }
    }
    if (url.pathname === '/api/token' && method === 'DELETE') {
      const cfg = loadConfig();
      delete cfg.token;
      saveConfig(cfg);
      return json(200, { ok: true });
    }
    if (url.pathname === '/api/token' && method === 'POST') {
      const token = ((body || {}).token || '').trim();
      if (!token) return json(400, { error: 'token required' });
      try {
        const res2 = await fetch('https://api.notion.com/v1/users/me', {
          headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
        });
        if (!res2.ok) {
          const d = await res2.json().catch(() => ({}));
          return json(200, { ok: false, error: d.code || res2.status });
        }
      } catch (e) { return json(200, { ok: false, error: String(e) }); }
      const cfg = loadConfig(); cfg.token = token; saveConfig(cfg);
      return json(200, { ok: true });
    }

    // --- アウトライン同期 ---
    if (url.pathname === '/api/outline' && method === 'POST') {
      if (!body || !body.fileId) return json(400, { error: 'fileId required' });
      try {
        return json(200, await syncOutline(body.fileId));
      } catch (e) {
        return json(200, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }

    // --- 初回セットアップ ---
    if (url.pathname === '/api/setup/detect' && method === 'POST') {
      try {
        return json(200, await detectDatabases());
      } catch (e) {
        return json(200, { ok: false, error: String(e.message || e).slice(0, 300) });
      }
    }

    // --- files ---
    if (url.pathname === '/api/files' && method === 'GET') {
      const pages = await queryAll(FILES_DB());
      const files = pages.map(parseFile);
      files.sort((a, b) => b.edited.localeCompare(a.edited));
      return json(200, { files });
    }
    if (url.pathname === '/api/files' && method === 'POST') {
      const b = body || {};
      const kind = b.kind || 'マップ';
      const name = b.name || (kind === 'フォルダ' ? '新しいファイル' : '無題のマインドマップ');
      const pg = await notion('/pages', 'POST', {
        parent: { database_id: FILES_DB() },
        properties: fileProps({ name, kind, parentId: b.parentId || null }),
      });
      let root = null;
      if (kind !== 'フォルダ') {
        const rootPg = await notion('/pages', 'POST', {
          parent: { database_id: NODES_DB() },
          properties: nodeProps({ name, fileId: pg.id, order: 0, topicType: 'タイトルトピック' }),
        });
        root = parseNode(rootPg);
      }
      return json(200, { file: parseFile(pg), root });
    }
    if (parts[1] === 'files' && parts[2] && method === 'GET') {
      const pg = await notion(`/pages/${parts[2]}`);
      return json(200, { file: parseFile(pg) });
    }
    if (parts[1] === 'files' && parts[2] && method === 'PATCH') {
      const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { properties: fileProps(body || {}) });
      return json(200, { file: parseFile(pg) });
    }
    if (parts[1] === 'files' && parts[2] && method === 'DELETE') {
      const deleteFileRec = async (id) => {
        const inner = await queryAll(FILES_DB(), { property: '親ファイル', relation: { contains: id } });
        for (const f of inner) await deleteFileRec(f.id);
        const nodes = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: id } });
        for (const n of nodes) await notion(`/pages/${n.id}`, 'PATCH', { archived: true });
        await notion(`/pages/${id}`, 'PATCH', { archived: true });
      };
      await deleteFileRec(parts[2]);
      return json(200, { ok: true });
    }

    // --- 添付ファイル(トピックのNotionページ本文にファイルとして保存する) ---
    if (parts[1] === 'nodes' && parts[2] && parts[3] === 'attachments') {
      const nodeId = parts[2];
      if (method === 'GET') {
        return json(200, { attachments: await listAttachments(nodeId) });
      }
      if (method === 'POST') {
        const filename = decodeURIComponent(request.headers.get('x-filename') || 'file');
        const contentType = request.headers.get('content-type') || 'application/octet-stream';
        const up = await notion('/file_uploads', 'POST', { mode: 'single_part', filename });
        const fd = new FormData();
        fd.append('file', new Blob([rawBuf], { type: contentType }), filename);
        const upRes = await fetch(`https://api.notion.com/v1/file_uploads/${up.id}/send`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + loadConfig().token, 'Notion-Version': NOTION_VERSION },
          body: fd,
        });
        if (!upRes.ok) {
          const d = await upRes.json().catch(() => ({}));
          return json(502, { error: d.message || 'upload failed' });
        }
        await notion(`/blocks/${nodeId}/children`, 'PATCH', {
          children: [{ object: 'block', type: 'file', file: { type: 'file_upload', file_upload: { id: up.id }, name: filename } }],
        });
        await ensureAttachProp();
        try { await notion(`/pages/${nodeId}`, 'PATCH', { properties: { '添付': { checkbox: true } } }); } catch {}
        return json(200, { attachments: await listAttachments(nodeId) });
      }
      if (method === 'DELETE') {
        const blockId = parts[4] || url.searchParams.get('block');
        if (!blockId) return json(400, { error: 'block required' });
        await notion(`/blocks/${blockId}`, 'DELETE');
        const rest = await listAttachments(nodeId);
        await ensureAttachProp();
        try { await notion(`/pages/${nodeId}`, 'PATCH', { properties: { '添付': { checkbox: rest.length > 0 } } }); } catch {}
        return json(200, { attachments: rest });
      }
    }

    // --- nodes ---
    if (parts[1] === 'nodes' && parts[2] && parts[3] === 'image' && method === 'POST') {
      const filename = decodeURIComponent(request.headers.get('x-filename') || 'image.png');
      const contentType = request.headers.get('content-type') || 'image/png';
      const up = await notion('/file_uploads', 'POST', { mode: 'single_part', filename });
      const fd = new FormData();
      fd.append('file', new Blob([rawBuf], { type: contentType }), filename);
      const upRes = await fetch(`https://api.notion.com/v1/file_uploads/${up.id}/send`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + loadConfig().token, 'Notion-Version': NOTION_VERSION },
        body: fd,
      });
      if (!upRes.ok) {
        const d = await upRes.json().catch(() => ({}));
        return json(502, { error: d.message || 'upload failed' });
      }
      const pg = await notion(`/pages/${parts[2]}`, 'PATCH', {
        properties: { '画像': { files: [{ type: 'file_upload', file_upload: { id: up.id }, name: filename }] } },
      });
      return json(200, { node: parseNode(pg) });
    }
    if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'GET') {
      const pages = await queryAll(NODES_DB(), { property: 'ファイル', relation: { contains: parts[2] } });
      return json(200, { nodes: pages.map(parseNode) });
    }
    if (url.pathname === '/api/nodes' && method === 'POST') {
      const pg = await notion('/pages', 'POST', {
        parent: { database_id: NODES_DB() },
        properties: nodeProps(body || {}),
      });
      return json(200, { node: parseNode(pg) });
    }
    if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'PATCH') {
      const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { properties: nodeProps(body || {}) });
      return json(200, { node: parseNode(pg) });
    }
    if (parts[1] === 'nodes' && parts[2] && !parts[3] && method === 'DELETE') {
      // 子孫もNotion側で探してまとめてアーカイブする。
      // (画面を開いた後に別の場所で足された子は画面が知らないので、親だけ消えて取り残されるのを防ぐ)
      const seen = new Set();
      const archiveTree = async (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        const kids = await queryAll(NODES_DB(), { property: '親ノード', relation: { contains: id } });
        for (const k of kids) await archiveTree(k.id);
        await notion(`/pages/${id}`, 'PATCH', { archived: true });
      };
      await archiveTree(parts[2]);
      return json(200, { ok: true });
    }
    if (parts[1] === 'nodes' && parts[2] && parts[3] === 'refresh' && method === 'GET') {
      const pg = await notion(`/pages/${parts[2]}`);
      return json(200, { node: parseNode(pg) });
    }
    if (parts[1] === 'nodes' && parts[2] && parts[3] === 'restore' && method === 'POST') {
      const pg = await notion(`/pages/${parts[2]}`, 'PATCH', { archived: false });
      return json(200, { node: parseNode(pg) });
    }

    return json(404, { error: 'not found' });
  }

  /** 例外をまとめて受け止める入口 */
  async function fetchApi(request) {
    try {
      return await handleApi(request);
    } catch (e) {
      return json(e.status === 401 ? 401 : 500, { error: e.message, code: e.code });
    }
  }

  return { fetchApi };
}
