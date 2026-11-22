// Proxy normalization, rotation and real SOCKS handshakes.
// Run: node --test test/proxy.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  normalizeProxy,
  normalizeProxyType,
  proxyInfo,
  proxyForPlaywright,
  describeProxy,
  parseProxyList,
  createRotator,
} from '../lib/proxy.js';
import { Transport } from '../lib/http.js';

test('disabled values', () => {
  for (const value of [null, '', 'none', 'OFF', 'null', 'direct']) {
    assert.equal(normalizeProxy(value), null);
  }
});

test('all proxy types from URL', () => {
  for (const type of ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
    assert.equal(normalizeProxy(`${type}://host.example:1080`), `${type}://host.example:1080`);
  }
});

test('bare host:port uses http by default', () => {
  assert.equal(normalizeProxy('proxy.example:3128'), 'http://proxy.example:3128');
});

test('bare host:port uses explicit type', () => {
  assert.equal(normalizeProxy('proxy.example:1080', 'socks5'), 'socks5://proxy.example:1080');
});

test('object form with credentials', () => {
  assert.equal(
    normalizeProxy({ type: 'socks5', host: '10.0.0.1', port: 1080, username: 'u', password: 'p@ss' }),
    'socks5://u:p%40ss@10.0.0.1:1080'
  );
});

test('aliases and explicit override', () => {
  assert.equal(normalizeProxyType('socks'), 'socks5');
  assert.equal(normalizeProxyType('SOCKS-5'), 'socks5');
  assert.equal(normalizeProxy('http://h:80', 'socks5'), 'http://h:80');
});

test('default ports', () => {
  assert.equal(normalizeProxy('socks5://host'), 'socks5://host:1080');
  assert.equal(normalizeProxy('https://host'), 'https://host:443');
});

test('invalid input fails clearly', () => {
  assert.throws(() => normalizeProxy('ftp://host:21'), /unsupported proxy type/);
  assert.throws(() => normalizeProxy('host'), /invalid proxy address|invalid proxy port/);
  assert.throws(() => normalizeProxy({ type: 'http', host: 'h', port: 99999 }), /invalid proxy port/);
});

test('IPv6 addresses stay bracketed in the canonical URL', () => {
  assert.equal(normalizeProxy('[::1]:1080'), 'http://[::1]:1080');
  assert.equal(normalizeProxy('socks5://[2001:db8::1]:1080'), 'socks5://[2001:db8::1]:1080');
  assert.equal(proxyInfo('socks5://[::1]:1080').host, '::1');
});

test('playwright options and masking', () => {
  assert.deepEqual(proxyForPlaywright('socks5://u:p@host:1080', 'localhost'), {
    server: 'socks5://host:1080',
    username: 'u',
    password: 'p',
    bypass: 'localhost',
  });
  assert.equal(proxyForPlaywright(null), undefined);
  assert.equal(describeProxy('socks5://u:p@host:1080'), 'socks5://host:1080 (auth)');
  assert.equal(proxyInfo('socks4a://host:1080').remoteDns, true);
});

test('proxy list from text with comments', () => {
  const list = parseProxyList('# first\nhttp://1.2.3.4:8080\n\n10.0.0.2:3128 # inline\n', 'socks5');
  assert.deepEqual(list, ['http://1.2.3.4:8080', 'socks5://10.0.0.2:3128']);
});

test('proxy list from JSON array', () => {
  const list = parseProxyList('["socks5://u:p@host:1080", {"type":"http","host":"h","port":80}]');
  assert.deepEqual(list, ['socks5://u:p@host:1080', 'http://h:80']);
});

test('bracketed IPv6 list entries are not mistaken for JSON', () => {
  assert.deepEqual(parseProxyList('[::1]:1080\n# comment\nhttp://host:8080'), [
    'http://[::1]:1080',
    'http://host:8080',
  ]);
  assert.deepEqual(parseProxyList('[2001:db8::1]:1080\nhttp://host:8080'), [
    'http://[2001:db8::1]:1080',
    'http://host:8080',
  ]);
});

test('proxy list rejects empty and malformed input', () => {
  assert.throws(() => parseProxyList('  \n  '), /empty/);
  assert.throws(() => parseProxyList('["http://h:80"'), /not valid JSON/);
});

test('round-robin rotator cycles all proxies', () => {
  const rotator = createRotator(['a', 'b', 'c']);
  assert.equal(rotator.size, 3);
  assert.equal(rotator.next(), 'a');
  assert.equal(rotator.next(), 'b');
  assert.equal(rotator.next(), 'c');
  assert.equal(rotator.next(), 'a');
  assert.equal(createRotator([]), null);
});

// ── end-to-end: a tiny local SOCKS4/SOCKS5 server and a local HTTP target ──

function startHttpTarget() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('PONG');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startSocksServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let stage = 'hello';
      let upstream = null;

      const pump = (host, port) => {
        upstream = net.connect(port, host, () => {
          if (buffer.length) upstream.write(buffer);
          buffer = Buffer.alloc(0);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
      };

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (stage === 'hello') {
          if (buffer.length < 3) return;
          if (buffer[0] === 5) {
            buffer = buffer.subarray(3);
            socket.write(Buffer.from([5, 0])); // no auth
            stage = 'request5';
          } else if (buffer[0] === 4) {
            stage = 'request4';
          } else {
            socket.destroy();
            return;
          }
        }

        if (stage === 'request5') {
          if (buffer.length < 5) return;
          const atyp = buffer[3];
          const addrLen = atyp === 1 ? 4 : atyp === 3 ? 1 + buffer[4] : atyp === 4 ? 16 : 0;
          if (!addrLen) return socket.destroy();
          const total = 4 + addrLen + 2;
          if (buffer.length < total) return;
          const host = atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : buffer.subarray(5, 5 + buffer[4]).toString();
          const port = buffer.readUInt16BE(total - 2);
          buffer = buffer.subarray(total);
          stage = 'pipe';
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          pump(host, port);
          return;
        }

        if (stage === 'request4') {
          const userEnd = buffer.indexOf(0, 8);
          if (userEnd < 0) return;
          const port = buffer.readUInt16BE(2);
          const ip = [...buffer.subarray(4, 8)];
          let host = ip.map(String).join('.');
          let rest = buffer.subarray(userEnd + 1);
          if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] === 1) {
            const domainEnd = rest.indexOf(0);
            if (domainEnd > 0) {
              host = rest.subarray(0, domainEnd).toString();
              rest = rest.subarray(domainEnd + 1);
            }
          }
          buffer = rest;
          stage = 'pipe';
          socket.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
          pump(host, port);
          return;
        }

        if (stage === 'pipe' && buffer.length && upstream) {
          upstream.write(buffer);
          buffer = Buffer.alloc(0);
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const target = await startHttpTarget();
const socks = await startSocksServer();
const targetUrl = `http://127.0.0.1:${target.address().port}/`;

after(async () => {
  await new Promise((r) => socks.close(r));
  await new Promise((r) => target.close(r));
});

for (const type of ['socks5', 'socks4']) {
  test(`HTTP request through ${type.toUpperCase()}`, async () => {
    const proxy = `${type}://127.0.0.1:${socks.address().port}`;
    const result = await new Transport({ proxy, timeout: 5000 }).request(targetUrl);
    assert.equal(result.status, 200);
    assert.equal(result.text, 'PONG');
  });
}
