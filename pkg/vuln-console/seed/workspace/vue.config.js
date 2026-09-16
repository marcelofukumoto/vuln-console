// Written by the Dev extension. See pkg/dev-extension/workspace-config.ts.
//
// This dev server is reached one of two ways, and everything below is the consequence of which.
//
//   - behind the apiserver's service proxy, at DEV_PROXY_PATH, on Rancher's own origin. The Host
//     header is the proxy's, the TLS the browser sees is Rancher's, the prefix is stripped on the
//     way in and has to be put back on every URL handed out.
//   - at an origin of its own, on a node port, with no prefix at all.
//
// A dev server built for one does not work at the other: the router base is baked in. Which one
// this is comes from DEV_PROXY_PATH being set or empty, and changing it restarts the pod.
//
// The second mode exists because of what the first one does to a dashboard. rancher/dashboard
// builds its API URLs absolute from the page origin, so behind the prefix its /v1 and /v3 calls
// never reach this dev server at all: they go to the Rancher this page was served from, using
// that session, against that cluster. Measured, on a workspace with a Rancher of its own: two
// requests arrived here and a hundred and thirty-six went to the host. An origin of its own is
// the only thing that fixes it, because there is no browser-side API base to set.
const proxyPath = (process.env.DEV_PROXY_PATH || '').replace(/\/$/, '');

// The prefix on every in-app link, which has to be the path the page was loaded at. Set before
// the shell's config runs, because the shell reads it out of the environment as it does.
process.env.ROUTER_BASE = proxyPath ? proxyPath + '/' : '/';

// The repo's own config, untouched in the checkout, rather than a reimplementation of it.
// rancher/dashboard is a monorepo whose shell is ./shell rather than a node_modules package,
// and which arguments its root config passes to that shell is the repo's business and changes
// with the repo. Wrapping it means this file only has to know about the proxy. This file is
// handed to vue-cli-service as VUE_CLI_SERVICE_CONFIG_PATH (see apps.ts, WORKSPACE_SCRIPT), so
// it lives outside the checkout and the checkout's own vue.config.js is never rewritten: the
// tree stays clean, a branch switch never trips over it, and nothing an agent commits carries it.
const base = require(require('path').join(process.cwd(), 'vue.config.js'));

// The proxy rewrites absolute URLs in HTML as they pass through, which is what lets a naive UI
// work behind it at all, so an asset URL that already carried the prefix would carry it twice.
// index.html therefore asks for '/js/...' and lets the proxy add the prefix, while webpack's
// runtime works its own base out from the script URL it was loaded from.
base.publicPath = 'auto';

const previousChainWebpack = base.chainWebpack;

base.chainWebpack = (webpackConfig) => {
  if (typeof previousChainWebpack === 'function') {
    previousChainWebpack(webpackConfig);
  }

  webpackConfig.plugin('html-index').tap((args) => {
    args[0].publicPath = '/';

    return args;
  });
};

base.devServer = {
  ...base.devServer,

  // Plain http only behind the proxy, where Rancher terminates TLS and will not talk to the
  // shell's self-signed dev certificate on the way through.
  //
  // At its own origin the browser talks to this server directly, and http there is not a smaller
  // problem than a certificate warning, it is a broken login: the shipped proxy sets
  // x-forwarded-proto: https on every request it makes, so Rancher issues its session cookie with
  // Secure, and a browser on http throws that cookie away. What that looks like is a login that
  // returns 200 and a page that bounces straight back to the login form, which is what it did.
  // So https here, with the shell's own certificate, and a warning to click through once.
  ...(proxyPath ? { server: { type: 'http' } } : {}),

  // Requests arrive with whatever Host the proxy chain last set, never this server's own.
  // Without this the proxy answers 'Invalid Host header'.
  allowedHosts: 'all',

  // The proxy cannot rewrite URLs in a compressed body: the response comes back as a stream
  // error and the browser shows a blank page.
  compress: false,

  // The prefix is stripped before a request lands here, so everything is served from the root.
  devMiddleware: { publicPath: '/' },
  static:        { publicPath: '/' },

  // A deep link into the dashboard has to load the app rather than 404. disableDotRule matters
  // in Rancher, where a route routinely carries a resource name with dots in it.
  historyApiFallback: {
    index:             '/index.html',
    disableDotRule:    true,
    htmlAcceptHeaders: ['text/html', 'application/xhtml+xml']
  },

  hot:             true,
  webSocketServer: { type: 'ws', options: { path: '/ws' } },
  client:          {
    // Hot reload rides the same proxy when there is one, and the page's own origin when there is
    // not. Either way this has to be written out, because the shell's config has an address of its
    // own in it and that address is not where this server is.
    //
    // Behind the proxy only the path is ours; the rest are webpack-dev-server's "infer it from
    // window.location" sentinels. 'auto' is one the *server* substitutes as it serves the client.
    //
    // Served at its own origin the sentinels are still needed, and leaving them out was a real
    // bug rather than a tidy default. The shell's own config sets a fixed
    // wss://localhost:8005/ws, which is right on a laptop running the dev server and wrong
    // everywhere else: the browser then opened a hot-reload socket to whatever was on port 8005
    // of the machine the browser is on, and displayed that server's compile errors over this
    // dashboard. Seen here as a webpack overlay full of a completely different project's module
    // resolution failures, sitting on top of the workspace's login form and swallowing clicks.
    //
    // 0.0.0.0 and 0 are webpack-dev-server's own "take it from window.location" sentinels. The
    // protocol is written out rather than left as 'auto', because 'auto' is substituted by the
    // server as it serves the client and is handed to the WebSocket constructor unchanged when
    // the page was loaded directly. This server is https at its own origin, so wss.
    webSocketURL: proxyPath ? {
      protocol: 'auto',
      hostname: '0.0.0.0',
      port:     0,
      pathname: proxyPath + '/ws'
    } : {
      protocol: 'wss',
      hostname: '0.0.0.0',
      port:     0,
      pathname: '/ws'
    },
    // The compile-error overlay would cover the whole framed dashboard for whoever is looking
    // when an edit fails to compile.
    overlay: false
  }
};

module.exports = base;
