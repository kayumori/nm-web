// Cloudflare Worker の入口。/api/* はNotionと通信し、それ以外は画面ファイルを返す
import { createApi } from '../core.mjs';

// キャッシュを活かすためAPIは使い回す
let api = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      api ||= createApi({ env, mode: 'hosted' });
      return api.fetchApi(request);
    }
    return env.ASSETS.fetch(request);
  },
};
