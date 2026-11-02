#!/usr/bin/env node
// Generates editable draw.io (diagrams.net) versions of the C4 diagrams in docs/c4/.
// The PlantUML sources (docs/c4/*.puml) are rendered to PNG separately; this keeps
// a hand-editable copy in the format the brief asks for.
//   node scripts/generate-drawio.mjs
//
// Nodes sit on a grid. Edges are routed orthogonally: they leave a box from a port
// spread along its side, run in their own lane through the gap between rows, and
// enter the target from the facing side - so lines never cut through boxes. Edges
// that must go around something give explicit waypoints (`via`).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'c4');
const LAYOUT = { cellW: 220, cellH: 190, boxW: 180, boxH: 100, left: 60, top: 80, laneStep: 13 };

const STYLES = {
  person: 'html=1;whiteSpace=wrap;rounded=1;arcSize=30;fillColor=#08427B;strokeColor=#073B6F;fontColor=#ffffff;align=center;verticalAlign=middle;',
  system: 'html=1;whiteSpace=wrap;rounded=1;arcSize=10;fillColor=#1168BD;strokeColor=#0B4884;fontColor=#ffffff;align=center;',
  external: 'html=1;whiteSpace=wrap;rounded=1;arcSize=10;fillColor=#999999;strokeColor=#8A8A8A;fontColor=#ffffff;align=center;',
  container: 'html=1;whiteSpace=wrap;rounded=1;arcSize=10;fillColor=#438DD5;strokeColor=#3C7FC0;fontColor=#ffffff;align=center;',
  component: 'html=1;whiteSpace=wrap;rounded=1;arcSize=10;fillColor=#85BBF0;strokeColor=#78A8D8;fontColor=#000000;align=center;',
  database: 'shape=cylinder3;html=1;whiteSpace=wrap;boundedLbl=1;backgroundOutline=1;size=12;fillColor=#438DD5;strokeColor=#3C7FC0;fontColor=#ffffff;align=center;',
  queue: 'shape=cylinder3;direction=south;html=1;whiteSpace=wrap;boundedLbl=1;backgroundOutline=1;size=12;fillColor=#438DD5;strokeColor=#3C7FC0;fontColor=#ffffff;align=center;',
  boundary: 'html=1;whiteSpace=wrap;rounded=1;arcSize=2;absoluteArcSize=1;dashed=1;dashPattern=8 4;fillColor=none;strokeColor=#666666;fontColor=#333333;align=left;verticalAlign=bottom;spacingLeft=10;spacingBottom=4;fontStyle=1;connectable=0;',
  edge: 'html=1;endArrow=blockThin;endFill=1;endSize=10;strokeColor=#707070;fontColor=#404040;fontSize=10;labelBackgroundColor=#ffffff;rounded=1;edgeStyle=none;',
  title: 'text;html=1;fontSize=18;fontStyle=1;align=left;verticalAlign=middle;strokeColor=none;fillColor=none;',
  legend: 'text;html=1;fontSize=11;align=left;verticalAlign=top;strokeColor=#cccccc;fillColor=#fafafa;spacing=8;',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function label({ name, tech, desc, kind }) {
  const typeLabel = { person: 'Person', system: 'Software System', external: 'External System' }[kind];
  const meta = tech ? `[${typeLabel ? `${typeLabel}: ` : ''}${tech}]` : typeLabel ? `[${typeLabel}]` : '';
  return `<b style="font-size:13px">${name}</b><div style="font-size:10px">${meta}</div><div style="font-size:11px;margin-top:6px">${desc}</div>`;
}

function diagram({ file, title, nodes, edges, boundaries = [], router = 'ortho', legend, ...layout }) {
  const L = { ...LAYOUT, ...layout };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const geo = (n) => ({
    x: L.left + n.col * L.cellW,
    y: L.top + n.row * L.cellH,
    w: L.boxW + ((n.span || 1) - 1) * L.cellW,
    h: L.boxH,
  });
  // Grid helpers for waypoints: column centre, row centre, middle of the gap above a row.
  const h = {
    cx: (c) => L.left + c * L.cellW + L.boxW / 2,
    cy: (r) => L.top + r * L.cellH + L.boxH / 2,
    gap: (r) => L.top + r * L.cellH - (L.cellH - L.boxH) / 2,
    colGap: (c) => L.left + c * L.cellW - (L.cellW - L.boxW) / 2,
    right: (c) => L.left + c * L.cellW + L.boxW,
  };
  const center = (n) => {
    const g = geo(n);
    return { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  };

  // 1. Decide sides and waypoints for every edge.
  const routes = edges.map(([from, to, , , opts = {}]) => {
    const s = byId.get(from);
    const t = byId.get(to);
    if (!s || !t) throw new Error(`unknown node in edge ${from} -> ${to}`);
    if (router === 'straight') return { s, t, straight: true };
    if (opts.via) return { s, t, exit: opts.exit, entry: opts.entry, via: opts.via(h) };
    if (s.row === t.row) {
      const right = t.col > s.col;
      return { s, t, exit: right ? 'right' : 'left', entry: right ? 'left' : 'right' };
    }
    const down = t.row > s.row;
    return { s, t, exit: down ? 'bottom' : 'top', entry: down ? 'top' : 'bottom', laneGap: down ? t.row : s.row };
  });

  // 2. Spread the ports on each box side, ordered by where the line goes next.
  const sides = new Map();
  routes.forEach((r, i) => {
    if (r.straight) return;
    const towards = (end) => {
      if (r.via?.length) {
        const p = end === 's' ? r.via[0] : r.via[r.via.length - 1];
        return { x: p[0], y: p[1] };
      }
      return center(end === 's' ? r.t : r.s);
    };
    for (const [end, node, side] of [['s', r.s, r.exit], ['t', r.t, r.entry]]) {
      const key = `${node.id}:${side}`;
      if (!sides.has(key)) sides.set(key, []);
      const p = towards(end);
      sides.get(key).push({ i, end, sort: side === 'top' || side === 'bottom' ? p.x : p.y });
    }
  });
  for (const list of sides.values()) {
    list.sort((a, b) => a.sort - b.sort);
    list.forEach((e, k) => {
      routes[e.i][e.end === 's' ? 'exitFrac' : 'entryFrac'] = (k + 1) / (list.length + 1);
    });
  }
  const port = (node, side, frac) => {
    const g = geo(node);
    if (side === 'top') return [g.x + frac * g.w, g.y];
    if (side === 'bottom') return [g.x + frac * g.w, g.y + g.h];
    if (side === 'left') return [g.x, g.y + frac * g.h];
    return [g.x + g.w, g.y + frac * g.h];
  };
  const constraint = (side, frac, prefix) => {
    const [x, y] = { top: [frac, 0], bottom: [frac, 1], left: [0, frac], right: [1, frac] }[side];
    return `${prefix}X=${x.toFixed(3)};${prefix}Y=${y.toFixed(3)};${prefix}Dx=0;${prefix}Dy=0;`;
  };

  // 3. Give each between-row segment its own lane so parallel lines don't overlap.
  const lanes = new Map(); // gapRow -> [{ offset, a, b }]
  const LANE_ORDER = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6];
  for (const r of routes) {
    if (r.laneGap === undefined) continue;
    const [sx] = port(r.s, r.exit, r.exitFrac);
    const [tx] = port(r.t, r.entry, r.entryFrac);
    if (Math.abs(sx - tx) < 2) continue; // vertical straight line, no lane needed
    const a = Math.min(sx, tx) - 8;
    const b = Math.max(sx, tx) + 8;
    const used = lanes.get(r.laneGap) || [];
    const offset = LANE_ORDER.find((o) => !used.some((u) => u.offset === o && u.a < b && a < u.b)) ?? 0;
    used.push({ offset, a, b });
    lanes.set(r.laneGap, used);
    const y = h.gap(r.laneGap) + offset * L.laneStep;
    r.via = [[sx, y], [tx, y]];
  }

  // 4. Emit XML.
  const cells = [];
  cells.push(`<mxCell id="title" value="${esc(title)}" style="${STYLES.title}" vertex="1" parent="1"><mxGeometry x="${L.left}" y="15" width="900" height="40" as="geometry"/></mxCell>`);

  for (const b of boundaries) {
    const x = L.left + b.cols[0] * L.cellW - 25;
    const y = L.top + b.rows[0] * L.cellH - 25;
    const w = (b.cols[1] - b.cols[0]) * L.cellW + L.boxW + 50;
    const hgt = (b.rows[1] - b.rows[0]) * L.cellH + L.boxH + 25 + 48;
    cells.push(`<mxCell id="${b.id}" value="${esc(`${b.name}<br><span style="font-weight:normal;font-size:10px">[${b.type}]</span>`)}" style="${STYLES.boundary}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${hgt}" as="geometry"/></mxCell>`);
  }

  for (const n of nodes) {
    const g = geo(n);
    cells.push(`<mxCell id="${n.id}" value="${esc(label(n))}" style="${STYLES[n.kind]}" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" as="geometry"/></mxCell>`);
  }

  edges.forEach(([from, to, text, tech, opts = {}], i) => {
    const r = routes[i];
    const value = tech ? `${text}<br><i>[${tech}]</i>` : text;
    let style = STYLES.edge;
    let points = '';
    if (!r.straight) {
      const sQueue = r.s.kind === 'queue';
      const tQueue = r.t.kind === 'queue';
      if (!sQueue) style += constraint(r.exit, r.exitFrac, 'exit');
      if (!tQueue) style += constraint(r.entry, r.entryFrac, 'entry');
      if (sQueue || tQueue) {
        r.via = [
          ...(sQueue ? [port(r.s, r.exit, r.exitFrac)] : []),
          ...(r.via || []),
          ...(tQueue ? [port(r.t, r.entry, r.entryFrac)] : []),
        ];
      }
      if (r.via?.length) {
        points = `<Array as="points">${r.via.map(([x, y]) => `<mxPoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('')}</Array>`;
      }
    }
    cells.push(`<mxCell id="e${i}" value="${esc(value)}" style="${style}" edge="1" parent="1" source="${from}" target="${to}"><mxGeometry relative="1"${opts.labelPos !== undefined ? ` x="${opts.labelPos}"` : ''} as="geometry">${points}</mxGeometry></mxCell>`);
  });

  if (legend) {
    cells.push(`<mxCell id="legend" value="${esc(legend.text)}" style="${STYLES.legend}" vertex="1" parent="1"><mxGeometry x="${h.colGap(legend.col) + 20}" y="${L.top + legend.row * L.cellH}" width="${L.boxW + 20}" height="${L.boxH}" as="geometry"/></mxCell>`);
  }

  const xml = `<mxfile host="app.diagrams.net" type="device">
  <diagram id="${file}" name="${esc(title)}">
    <mxGraphModel dx="1600" dy="1000" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
  writeFileSync(path.join(OUT, `${file}.drawio`), xml);
  console.log(`wrote docs/c4/${file}.drawio (${nodes.length} elements, ${edges.length} relationships)`);
}

const LEGEND = '<b>Legend</b><br>■ dark blue: person<br>■ blue: container / system<br>■ light blue: component<br>■ grey: external system<br>- - dashed: boundary';

// ---------------------------------------------------------------- Level 1
diagram({
  file: 'L1-context',
  title: 'SocialFlow - System Context (C4 Level 1)',
  router: 'straight',
  cellH: 150,
  nodes: [
    { id: 'mod', kind: 'person', name: 'Moderator / Admin', desc: 'Reviews reported content, manages accounts', col: 1, row: 0 },
    { id: 'user', kind: 'person', name: 'Social Media User', desc: 'Posts, follows, reads feed, chats (iOS, Android, web)', col: 4, row: 0 },
    { id: 'sf', kind: 'system', name: 'SocialFlow Platform', desc: 'Profiles, posts, personalised feed, likes/comments, notifications, DMs, search, moderation', col: 2, row: 1, span: 2 },
    { id: 'oauth', kind: 'external', name: 'Identity Providers', tech: 'Google, Facebook', desc: 'OAuth 2.0 / OIDC sign-in', col: 0, row: 3 },
    { id: 'email', kind: 'external', name: 'Email Service', tech: 'Amazon SES', desc: 'Verification, digests, GDPR exports', col: 1, row: 3 },
    { id: 'sms', kind: 'external', name: 'SMS Service', tech: 'Twilio', desc: 'Phone verification, 2FA', col: 2, row: 3 },
    { id: 'push', kind: 'external', name: 'Push Notifications', tech: 'APNs, FCM', desc: 'Mobile push delivery', col: 3, row: 3 },
    { id: 'analytics', kind: 'external', name: 'Analytics Platform', desc: 'Product analytics (consented events)', col: 4, row: 3 },
    { id: 'pay', kind: 'external', name: 'Payment Gateway', tech: 'Stripe', desc: 'Premium subscriptions', col: 5, row: 3 },
    { id: 'cdn', kind: 'external', name: 'CDN', tech: 'Amazon CloudFront', desc: 'Edge delivery of media & web assets', col: 5, row: 1 },
  ],
  edges: [
    ['user', 'sf', 'Uses', 'HTTPS / WSS'],
    ['mod', 'sf', 'Moderates content', 'HTTPS'],
    ['user', 'cdn', 'Downloads media', 'HTTPS'],
    ['sf', 'cdn', 'Publishes media to', 'S3 origin'],
    ['sf', 'oauth', 'Authenticates users with', 'OIDC'],
    ['sf', 'email', 'Sends email via', 'HTTPS API'],
    ['sf', 'sms', 'Sends SMS via', 'HTTPS API'],
    ['sf', 'push', 'Sends push via', 'HTTPS/2'],
    ['sf', 'analytics', 'Streams events to', 'HTTPS'],
    ['sf', 'pay', 'Charges via / webhooks', 'HTTPS'],
  ],
  legend: { text: LEGEND, col: 0, row: 0 },
});

// ---------------------------------------------------------------- Level 2
// Columns 0-8 are inside the system boundary; column 9.3 holds external systems.
diagram({
  file: 'L2-container',
  title: 'SocialFlow - Container Diagram (C4 Level 2)',
  cellH: 250,
  cellW: 250,
  laneStep: 11,
  boundaries: [{ id: 'b', name: 'SocialFlow Platform', type: 'Software System', cols: [0, 8], rows: [1, 4] }],
  nodes: [
    { id: 'user', kind: 'person', name: 'Social Media User', desc: 'Mobile & web', col: 3, row: 0 },
    { id: 'oauth', kind: 'external', name: 'Identity Providers', tech: 'Google, Facebook', desc: 'OIDC sign-in', col: 9.3, row: 0 },
    { id: 'spa', kind: 'container', name: 'Web Application', tech: 'React SPA', desc: 'Browser client served from CDN', col: 2, row: 1 },
    { id: 'mobile', kind: 'container', name: 'Mobile Apps', tech: 'Swift / Kotlin', desc: 'iOS and Android clients', col: 4, row: 1 },
    { id: 'cdn', kind: 'external', name: 'CDN', tech: 'CloudFront', desc: 'Media & static assets', col: 9.3, row: 1 },
    { id: 'registry', kind: 'container', name: 'Service Registry', tech: 'Consul', desc: 'Registration, health checks, DNS discovery', col: 0, row: 2 },
    { id: 'gw', kind: 'container', name: 'API Gateway', tech: 'Kong (DB-less)', desc: 'Routing, JWT, rate limiting, CORS, correlation id', col: 3, row: 2 },
    { id: 'ws', kind: 'container', name: 'WebSocket Gateway', tech: 'Node.js', desc: 'Real-time notifications & DMs', col: 6, row: 2 },
    { id: 'msg', kind: 'container', name: 'Message Service', tech: 'Node.js', desc: 'Direct & group messages', col: 0, row: 3 },
    { id: 'us', kind: 'container', name: 'User Service', tech: 'Node.js', desc: 'Accounts, profiles, follow graph', col: 1, row: 3 },
    { id: 'fs', kind: 'container', name: 'Feed Service', tech: 'Node.js', desc: 'Fan-out, timeline cache, ranking', col: 2, row: 3 },
    { id: 'ps', kind: 'container', name: 'Post Service', tech: 'Node.js', desc: 'Posts, likes, comments; outbox', col: 3, row: 3 },
    { id: 'ns', kind: 'container', name: 'Notification Service', tech: 'Node.js', desc: 'In-app, push, email, SMS', col: 4, row: 3 },
    { id: 'media', kind: 'container', name: 'Media Service', tech: 'Go', desc: 'Presigned uploads, transcoding', col: 5, row: 3 },
    { id: 'search', kind: 'container', name: 'Search Service', tech: 'Node.js', desc: 'Users, posts, hashtags', col: 6, row: 3 },
    { id: 'modsvc', kind: 'container', name: 'Moderation Service', tech: 'Python', desc: 'Classification, report queue, takedowns', col: 7, row: 3 },
    { id: 'billing', kind: 'container', name: 'Billing Service', tech: 'Node.js', desc: 'Premium subscriptions, Stripe webhooks, entitlements', col: 8, row: 3 },
    { id: 'payment', kind: 'external', name: 'Payment Gateway', tech: 'Stripe', desc: 'Subscriptions & webhooks', col: 9.3, row: 3 },
    { id: 'analytics', kind: 'external', name: 'Analytics Platform', desc: 'Product analytics (consented events)', col: 3, row: 5 },
    { id: 'cass', kind: 'database', name: 'Wide-column Store', tech: 'Cassandra', desc: 'Timelines, messages, notifications', col: 0, row: 4 },
    { id: 'pg', kind: 'database', name: 'Relational DB', tech: 'PostgreSQL', desc: 'DB per service: users, posts, feed, media, moderation, billing', col: 1, row: 4 },
    { id: 'redis', kind: 'database', name: 'Cache', tech: 'Redis Cluster', desc: 'Timelines, post cache, counters', col: 2, row: 4 },
    { id: 'kafka', kind: 'queue', name: 'Event Bus', tech: 'Apache Kafka', desc: 'post.*, user.*, message.sent, subscription.*', col: 3, row: 4 },
    { id: 'es', kind: 'database', name: 'Search Index', tech: 'Elasticsearch', desc: 'Users, posts, hashtags', col: 6, row: 4 },
    { id: 's3', kind: 'database', name: 'Media Storage', tech: 'Amazon S3', desc: 'Images & video renditions', col: 7, row: 4 },
    { id: 'notify', kind: 'external', name: 'Push / Email / SMS', tech: 'APNs, FCM, SES, Twilio', desc: 'Offline delivery', col: 9.3, row: 5 },
  ],
  edges: [
    ['user', 'spa', 'Uses', 'HTTPS'],
    ['user', 'mobile', 'Uses'],
    ['spa', 'gw', 'API calls', 'HTTPS/JSON'],
    ['mobile', 'gw', 'API calls', 'HTTPS/JSON'],
    ['mobile', 'ws', 'Real-time', 'WSS'],
    ['mobile', 'cdn', 'Loads media', 'HTTPS'],
    ['gw', 'registry', 'Resolves upstreams', 'DNS SRV'],
    ['gw', 'msg', '/api/conversations'],
    ['gw', 'us', '/api/users'],
    ['gw', 'fs', '/api/feed'],
    ['gw', 'ps', '/api/posts'],
    ['gw', 'media', '/api/media'],
    ['gw', 'search', '/api/search'],
    ['gw', 'billing', '/api/billing'],
    ['fs', 'us', 'followers', 'breaker'],
    ['fs', 'ps', 'hydrate', 'breaker'],
    ['ns', 'ws', 'Online delivery'],
    ['msg', 'ws', 'Live delivery'],
    ['msg', 'cass', 'Messages', 'CQL'],
    ['us', 'pg', 'SQL'],
    ['ps', 'pg', 'SQL'],
    ['fs', 'redis', 'Timelines'],
    ['fs', 'cass', 'Durable timelines'],
    ['ns', 'cass', 'Notifications'],
    ['ps', 'kafka', 'post.*'],
    ['us', 'kafka', 'user.*'],
    ['msg', 'kafka', 'message.sent'],
    ['billing', 'kafka', 'subscription.*'],
    ['fs', 'kafka', 'consumes post.created'],
    ['ns', 'kafka', 'consumes interactions'],
    ['search', 'kafka', 'consumes index updates'],
    ['modsvc', 'kafka', 'consumes new content'],
    ['media', 'pg', 'Media metadata'],
    ['modsvc', 'pg', 'Reports, decisions'],
    ['billing', 'pg', 'Subscriptions'],
    ['billing', 'payment', 'Charges / webhooks', 'HTTPS'],
    ['kafka', 'analytics', 'Consented events', 'Kafka Connect'],
    ['search', 'es', 'Index / query'],
    ['media', 's3', 'Stores media'],
    // Long edges routed explicitly around other boxes.
    ['modsvc', 'ps', 'Hide / remove content', 'HTTP', { exit: 'bottom', entry: 'bottom', via: (h) => [[h.cx(7) + 60, h.gap(4) + 60], [h.cx(3) + 75, h.gap(4) + 60]] }],
    ['us', 'oauth', 'Sign-in', 'OIDC', { exit: 'top', entry: 'bottom', via: (h) => [[h.cx(1) - 30, h.gap(1) - 35], [h.cx(9.3), h.gap(1) - 35]] }],
    ['s3', 'cdn', 'Origin for', '', { labelPos: -0.7, exit: 'right', entry: 'left', via: (h) => [[h.right(8) + 50, h.cy(4)], [h.right(8) + 50, h.cy(1) + 17]] }],
    ['ns', 'notify', 'Offline delivery', 'HTTPS', { exit: 'bottom', entry: 'left', via: (h) => [[h.cx(4) + 45, h.cy(5)]] }],
  ],
  legend: { text: LEGEND, col: 0, row: 0 },
});

// ---------------------------------------------------------------- Level 3
// Columns 1-4 are the Feed Service; column 0 and 5 hold neighbouring containers.
diagram({
  file: 'L3-feed-components',
  title: 'SocialFlow - Feed Service Components (C4 Level 3)',
  boundaries: [{ id: 'b', name: 'Feed Service', type: 'Container: Node.js / Express', cols: [1, 4], rows: [1, 3] }],
  nodes: [
    { id: 'gw', kind: 'container', name: 'API Gateway', tech: 'Kong', desc: 'Routes /api/feed', col: 1, row: 0 },
    { id: 'kafka', kind: 'queue', name: 'Event Bus', tech: 'Kafka', desc: 'Topic post.created', col: 4, row: 0 },
    { id: 'db', kind: 'database', name: 'Feed Store', tech: 'Postgres (POC) / Cassandra', desc: 'feed_items, author_posts', col: -0.25, row: 1 },
    { id: 'api', kind: 'component', name: 'Feed API Controller', tech: 'Express route', desc: 'GET /feed - identity, limit, cursor', col: 1, row: 1 },
    { id: 'fanout', kind: 'component', name: 'Fan-out Worker', tech: 'kafkajs consumer', desc: 'post.created: push to followers or store for pull', col: 4, row: 1 },
    { id: 'ps', kind: 'container', name: 'Post Service', tech: 'Node.js', desc: 'GET /posts?ids=', col: 5.25, row: 1 },
    { id: 'gen', kind: 'component', name: 'Feed Generator', tech: 'Module', desc: 'cache -> DB fallback -> aggregate -> rank', col: 1, row: 2 },
    { id: 'agg', kind: 'component', name: 'Content Aggregator', tech: 'Module', desc: 'Merge pushed + celebrity posts, hydrate', col: 2, row: 2 },
    { id: 'clients', kind: 'component', name: 'Service Clients', tech: 'opossum + fetch', desc: 'Circuit breakers, Consul resolution', col: 4, row: 2 },
    { id: 'registry', kind: 'container', name: 'Service Registry', tech: 'Consul', desc: 'Healthy instances', col: 5.25, row: 2 },
    { id: 'rank', kind: 'component', name: 'Ranking Engine', tech: 'Pure function', desc: 'Recency decay x engagement', col: 1, row: 3 },
    { id: 'cache', kind: 'component', name: 'Timeline Cache', tech: 'ioredis + Lua', desc: 'Per-user ZSETs, warm-only push, post cache', col: 2, row: 3 },
    { id: 'us', kind: 'container', name: 'User Service', tech: 'Node.js', desc: 'Followers / following', col: 5.25, row: 3 },
    { id: 'redis', kind: 'database', name: 'Redis', tech: 'Redis Cluster', desc: 'timeline:*, author_posts:*, post:*', col: 2, row: 4 },
  ],
  edges: [
    ['gw', 'api', 'GET /feed', 'HTTP'],
    ['api', 'gen', 'getFeed()'],
    ['gen', 'cache', '1. read timeline'],
    ['gen', 'db', '2. fallback + re-warm', 'SQL'],
    ['gen', 'agg', '3. aggregate'],
    ['gen', 'rank', '4. rank'],
    ['agg', 'cache', 'celebrity posts'],
    ['agg', 'clients', 'following, hydrate'],
    ['cache', 'redis', 'ZSET / Lua', 'RESP'],
    ['kafka', 'fanout', 'post.created', 'group feed-fanout'],
    ['fanout', 'clients', 'followers (paged)'],
    ['fanout', 'cache', 'pushIfWarm', '', { labelPos: -0.45, exit: 'left', entry: 'right', via: (h) => [[h.cx(3), h.cy(1)], [h.cx(3), h.cy(3)]] }],
    ['fanout', 'db', 'feed_items', 'SQL', { exit: 'top', entry: 'top', via: (h) => [[h.cx(4) - 45, h.gap(1) - 10], [h.cx(-0.25), h.gap(1) - 10]] }],
    ['clients', 'ps', 'hydrate', 'HTTP'],
    ['clients', 'registry', 'resolve', 'HTTP API'],
    ['clients', 'us', 'followers / following', 'HTTP'],
  ],
  legend: { text: LEGEND, col: 3, row: 4 },
});
